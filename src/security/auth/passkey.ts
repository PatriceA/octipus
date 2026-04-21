import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import { getConfig } from '@/config';
import { RedisCache } from '@/db/redis';
import { auditRepository } from '@/db/repositories/audit-repository';
import { userRepository } from '@/db/repositories/user-repository';
import type { PasskeyCredential } from '@/db/schema/users';
import { securityLogger } from '@/utils/logger';

// Redis-backed challenge storage with 5-minute TTL
const challengeCache = new RedisCache(300);

export class PasskeyAuth {
  private rpId: string;
  private rpName: string;
  private origin: string;

  constructor() {
    const config = getConfig();
    this.rpId = config.security.passkeyRpId;
    this.rpName = config.security.passkeyRpName;
    this.origin = config.security.passkeyOrigin;
  }

  /**
   * Generate registration options for a new passkey
   */
  async generateRegistrationOptions(userId: string, userName: string): Promise<{
    options: PublicKeyCredentialCreationOptionsJSON;
    challenge: string;
  }> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Get existing credentials to exclude
    const existingCredentials = (user.passkeyCredentials as PasskeyCredential[]).map((cred) => ({
      id: cred.id,
      type: 'public-key' as const,
      transports: cred.transports as AuthenticatorTransportFuture[] | undefined,
    })) as any;

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpId,
      userID: new TextEncoder().encode(userId) as any,
      userName,
      userDisplayName: userName,
      attestationType: 'none',
      excludeCredentials: existingCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store challenge in Redis (TTL handles expiration)
    await challengeCache.set(`passkey-challenge:${userId}`, {
      challenge: options.challenge,
    });

    return { options, challenge: options.challenge };
  }

  /**
   * Verify registration response and save credential
   */
  async verifyRegistration(
    userId: string,
    response: RegistrationResponseJSON,
    deviceName?: string
  ): Promise<VerifiedRegistrationResponse> {
    const challengeData = await challengeCache.get<{ challenge: string }>(`passkey-challenge:${userId}`);
    if (!challengeData) {
      throw new Error('Challenge expired or not found');
    }

    await challengeCache.delete(`passkey-challenge:${userId}`);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('Registration verification failed');
    }

    // Save credential
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const newCredential: PasskeyCredential = {
      id: Buffer.from(verification.registrationInfo.credentialID).toString('base64url'),
      publicKey: Buffer.from(verification.registrationInfo.credentialPublicKey).toString('base64'),
      counter: verification.registrationInfo.counter,
      transports: response.response.transports,
      deviceName,
      createdAt: new Date().toISOString(),
    };

    const credentials = [...(user.passkeyCredentials as PasskeyCredential[]), newCredential];
    await userRepository.update(userId, { passkeyCredentials: credentials });

    securityLogger.info({ userId, deviceName }, 'Passkey registered');

    return verification;
  }

  /**
   * Generate authentication options
   */
  async generateAuthenticationOptions(userId?: string): Promise<{
    options: PublicKeyCredentialRequestOptionsJSON;
    challenge: string;
  }> {
    let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;

    if (userId) {
      const user = await userRepository.findById(userId);
      if (user) {
        allowCredentials = (user.passkeyCredentials as PasskeyCredential[]).map((cred) => ({
          id: cred.id,
          type: 'public-key' as const,
          transports: cred.transports as AuthenticatorTransportFuture[] | undefined,
        })) as any;
      }
    }

    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: allowCredentials as any,
      userVerification: 'preferred',
    });

    // Store challenge in Redis (TTL handles expiration)
    const challengeKey = userId || 'anonymous';
    await challengeCache.set(`passkey-challenge:${challengeKey}`, {
      challenge: options.challenge,
    });

    return { options, challenge: options.challenge };
  }

  /**
   * Verify authentication response
   */
  async verifyAuthentication(
    userId: string,
    response: AuthenticationResponseJSON,
    ipAddress?: string
  ): Promise<VerifiedAuthenticationResponse> {
    const challengeData =
      (await challengeCache.get<{ challenge: string }>(`passkey-challenge:${userId}`)) ||
      (await challengeCache.get<{ challenge: string }>(`passkey-challenge:anonymous`));
    if (!challengeData) {
      throw new Error('Challenge expired or not found');
    }

    await challengeCache.delete(`passkey-challenge:${userId}`);
    await challengeCache.delete(`passkey-challenge:anonymous`);

    const user = await userRepository.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const credentials = user.passkeyCredentials as PasskeyCredential[];
    const credential = credentials.find((c) => c.id === response.id);

    if (!credential) {
      await auditRepository.logLoginFailed(user.username, ipAddress, 'Credential not found');
      throw new Error('Credential not found');
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challengeData.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpId,
      authenticator: {
        credentialID: new Uint8Array(Buffer.from(credential.id, 'base64url')),
        credentialPublicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64')),
        counter: credential.counter,
        transports: credential.transports as AuthenticatorTransportFuture[] | undefined,
      },
    });

    if (!verification.verified) {
      await auditRepository.logLoginFailed(user.username, ipAddress, 'Verification failed');
      throw new Error('Authentication verification failed');
    }

    // Update counter
    const updatedCredentials = credentials.map((c) =>
      c.id === credential.id
        ? { ...c, counter: verification.authenticationInfo.newCounter }
        : c
    );
    await userRepository.update(userId, { passkeyCredentials: updatedCredentials });
    await userRepository.updateLastLogin(userId);

    await auditRepository.logLogin(userId, ipAddress);
    securityLogger.info({ userId }, 'Passkey authentication successful');

    return verification;
  }

  /**
   * Remove a passkey credential
   */
  async removeCredential(userId: string, credentialId: string): Promise<boolean> {
    const user = await userRepository.findById(userId);
    if (!user) {
      return false;
    }

    const credentials = (user.passkeyCredentials as PasskeyCredential[]).filter(
      (c) => c.id !== credentialId
    );

    if (credentials.length === (user.passkeyCredentials as PasskeyCredential[]).length) {
      return false;
    }

    await userRepository.update(userId, { passkeyCredentials: credentials });
    securityLogger.info({ userId, credentialId }, 'Passkey removed');

    return true;
  }

  /**
   * List passkey credentials for a user (without sensitive data)
   */
  async listCredentials(userId: string): Promise<{ id: string; deviceName?: string; createdAt: string }[]> {
    const user = await userRepository.findById(userId);
    if (!user) {
      return [];
    }

    return (user.passkeyCredentials as PasskeyCredential[]).map((c) => ({
      id: c.id,
      deviceName: c.deviceName,
      createdAt: c.createdAt,
    }));
  }
}

// Type definitions for browser WebAuthn API
interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string;
  rp: { name: string; id?: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: 'public-key'; alg: number }[];
  timeout?: number;
  excludeCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  authenticatorSelection?: {
    authenticatorAttachment?: 'platform' | 'cross-platform';
    residentKey?: 'discouraged' | 'preferred' | 'required';
    userVerification?: 'discouraged' | 'preferred' | 'required';
  };
  attestation?: 'none' | 'indirect' | 'direct' | 'enterprise';
}

interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: { id: string; type: 'public-key'; transports?: string[] }[];
  userVerification?: 'discouraged' | 'preferred' | 'required';
}

// Singleton instance
let passkeyAuthInstance: PasskeyAuth | null = null;

export function getPasskeyAuth(): PasskeyAuth {
  if (!passkeyAuthInstance) {
    passkeyAuthInstance = new PasskeyAuth();
  }
  return passkeyAuthInstance;
}

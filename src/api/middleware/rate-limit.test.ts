import { describe, expect, test } from 'bun:test';
import { isCredentialAttempt } from './rate-limit';

/**
 * The tight per-IP window exists to stop credential stuffing. Which paths it
 * covers decides whether it protects the product or breaks it.
 */
describe('isCredentialAttempt', () => {
  test('covers every endpoint that takes a credential', () => {
    for (const p of [
      '/api/auth/login',
      '/api/auth/login-mobile',
      '/api/auth/register',
      '/api/auth/passkey/authenticate',
      '/api/auth/oauth/github/callback',
      '/api/auth/password/reset',
      '/api/auth/totp/verify',
      // Takes a 6-to-12-character binding code and, on a hit, attaches
      // another user's pending channel identity to the caller's account. It
      // was dropped when this list replaced the blanket `/api/auth/*` rule.
      '/api/auth/channel-bindings/redeem',
    ]) {
      expect(isCredentialAttempt(p)).toBe(true);
    }
  });

  test('does NOT cover session reads', () => {
    // Measured in the live UI pass: the web app reads `me` on every page mount
    // and takes a ws-ticket per socket, so clicking through the navigation
    // spent the 20/min credential-stuffing budget. A 429 on `me` reads to the
    // front-end as "not logged in", which left the composer disabled and the
    // settings page empty for a perfectly valid session.
    expect(isCredentialAttempt('/api/auth/me')).toBe(false);
    expect(isCredentialAttempt('/api/auth/ws-ticket')).toBe(false);
    expect(isCredentialAttempt('/api/auth/logout')).toBe(false);
  });

  test('covers only the redeeming half of channel bindings', () => {
    // Listing and unbinding are ordinary authenticated reads and writes; only
    // redeem takes a secret, so only redeem belongs in the tight window.
    expect(isCredentialAttempt('/api/auth/channel-bindings')).toBe(false);
    expect(isCredentialAttempt('/api/auth/channel-bindings/telegram/12345')).toBe(false);
  });

  test('does not reach outside /api/auth', () => {
    expect(isCredentialAttempt('/api/models')).toBe(false);
    expect(isCredentialAttempt('/api/chat')).toBe(false);
  });
});

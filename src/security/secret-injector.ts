import { auditRepository } from '@/db/repositories/audit-repository';
import { SECRET_PLACEHOLDER_PATTERN } from '@/db/schema/vault';
import { securityLogger } from '@/utils/logger';
import { getVault } from './vault';

export interface InjectionContext {
  userId: string;
  toolId?: string;
  agentId?: string;
}

export interface InjectionResult {
  content: string;
  injectedSecrets: string[];
  errors: string[];
}

/**
 * Inject secrets into content by replacing placeholders
 *
 * Placeholders follow the pattern: {{secret:credential_name}}
 */
export async function injectSecrets(
  content: string,
  context: InjectionContext
): Promise<InjectionResult> {
  const vault = getVault();
  const injectedSecrets: string[] = [];
  const errors: string[] = [];

  // Find all placeholders
  const matches = content.matchAll(SECRET_PLACEHOLDER_PATTERN);
  const replacements: Map<string, string> = new Map();

  for (const match of matches) {
    const fullMatch = match[0]; // {{secret:name}}
    const secretName = match[1]; // name

    if (replacements.has(fullMatch)) {
      continue; // Already processed
    }

    try {
      // Check access permission
      const canAccess = await vault.canAccessByName(context.userId, secretName, {
        toolId: context.toolId,
        agentId: context.agentId,
      });

      if (!canAccess) {
        securityLogger.warn(
          { userId: context.userId, secretName, toolId: context.toolId, agentId: context.agentId },
          'Secret access denied'
        );
        errors.push(`Access denied to secret: ${secretName}`);
        replacements.set(fullMatch, '[ACCESS_DENIED]');

        await auditRepository.log({
          userId: context.userId,
          action: 'credential_accessed',
          resourceType: 'credential',
          resourceId: secretName,
          details: { secretName, toolId: context.toolId, agentId: context.agentId, denied: true },
        });
        continue;
      }

      // Get the secret value
      const value = await vault.getByName(context.userId, secretName);

      if (value === null) {
        errors.push(`Secret not found: ${secretName}`);
        replacements.set(fullMatch, '[SECRET_NOT_FOUND]');
        continue;
      }

      replacements.set(fullMatch, value);
      injectedSecrets.push(secretName);

      securityLogger.debug(
        { userId: context.userId, secretName, toolId: context.toolId },
        'Secret injected'
      );

      await auditRepository.log({
        userId: context.userId,
        action: 'credential_accessed',
        resourceType: 'credential',
        resourceId: secretName,
        details: { secretName, toolId: context.toolId, agentId: context.agentId, injected: true },
      });
    } catch (error) {
      errors.push(`Error retrieving secret ${secretName}: ${(error as Error).message}`);
      replacements.set(fullMatch, '[SECRET_ERROR]');
    }
  }

  // Apply replacements
  let result = content;
  for (const [placeholder, value] of replacements) {
    result = result.split(placeholder).join(value);
  }

  return {
    content: result,
    injectedSecrets,
    errors,
  };
}

/**
 * Check if content contains secret placeholders
 */
export function hasSecretPlaceholders(content: string): boolean {
  return SECRET_PLACEHOLDER_PATTERN.test(content);
}

/**
 * Extract secret names from content
 */
export function extractSecretNames(content: string): string[] {
  const names: string[] = [];
  const matches = content.matchAll(SECRET_PLACEHOLDER_PATTERN);

  for (const match of matches) {
    if (!names.includes(match[1])) {
      names.push(match[1]);
    }
  }

  return names;
}

/**
 * Redact secrets from content for logging
 */
export function redactSecrets(content: string): string {
  return content.replace(SECRET_PLACEHOLDER_PATTERN, '[REDACTED:$1]');
}

/**
 * Create a secret placeholder
 */
export function createPlaceholder(secretName: string): string {
  return `{{secret:${secretName}}}`;
}

/**
 * Validate secret name format
 */
export function isValidSecretName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

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
  /**
   * The actual secret values that were resolved into `content`. Callers use
   * these to redact the values from tool output/logs so a resolved secret
   * can't be echoed back to the model (egress control). Never logged.
   */
  resolvedValues: string[];
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
  const resolvedValues: string[] = [];
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
      // Phase 1b-1: scope-aware lookup. `getForAgent` tries user scope
      // first, then system scope, applying the per-row tool/agent
      // allowlist at each step. A null return means either no row
      // exists or the allowlist denies this caller — either way the
      // secret is not surfaced to the agent.
      const value = await vault.getForAgent(
        { userId: context.userId, toolId: context.toolId, agentId: context.agentId },
        secretName,
      );

      if (value === null) {
        // We can't tell from here whether the row was missing or the
        // allowlist denied us — the vault treats both the same to avoid
        // leaking the existence of secrets the caller can't access.
        // Existence-vs-denial is logged inside the vault layer.
        securityLogger.warn(
          { userId: context.userId, secretName, toolId: context.toolId, agentId: context.agentId },
          'Secret unavailable (missing or access denied)'
        );
        errors.push(`Secret not found or access denied: ${secretName}`);
        replacements.set(fullMatch, '[SECRET_NOT_FOUND]');

        await auditRepository.log({
          userId: context.userId,
          action: 'credential_accessed',
          resourceType: 'credential',
          resourceId: secretName,
          details: { secretName, toolId: context.toolId, agentId: context.agentId, denied: true },
        });
        continue;
      }

      replacements.set(fullMatch, value);
      injectedSecrets.push(secretName);
      resolvedValues.push(value);

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
    resolvedValues,
  };
}

/**
 * Redact any resolved secret values from arbitrary content (e.g. a tool's
 * output before it is returned to the model or logged). Prevents a resolved
 * `{{secret:…}}` value from being echoed back out — the egress half of the
 * injection contract. No-op when no secrets were resolved.
 */
export function redactSecretValues(content: string, resolvedValues: string[]): string {
  if (resolvedValues.length === 0) return content;
  let out = content;
  for (const value of resolvedValues) {
    if (value) out = out.split(value).join('[REDACTED_SECRET]');
  }
  return out;
}

/**
 * Check if content contains secret placeholders.
 *
 * NOTE: `SECRET_PLACEHOLDER_PATTERN` is a global (`/g`) regex, so calling
 * `.test()` on it directly advances and persists `lastIndex` between calls —
 * consecutive checks on the same input would alternate true/false. Use a
 * fresh, non-global matcher here so the result is deterministic.
 */
export function hasSecretPlaceholders(content: string): boolean {
  return new RegExp(SECRET_PLACEHOLDER_PATTERN.source).test(content);
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

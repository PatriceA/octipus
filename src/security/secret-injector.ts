import { assertNoCredentialTemplates } from './credential-boundary';
import { SECRET_PLACEHOLDER_PATTERN } from '@/db/schema/vault';

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
 * Compatibility entry point for credential-free content. General vault
 * templating is prohibited; authenticated clients consume named credentials
 * inside their authorized client boundary.
 */
export async function injectSecrets(
  content: string,
  context: InjectionContext
): Promise<InjectionResult> {
  // Kept as a compatibility entry point. Resolution into arbitrary content
  // is unsafe even if returned output is masked: a process can write or encode
  // its environment before returning. No vault read occurs on this path.
  void context;
  assertNoCredentialTemplates(content);
  return { content, injectedSecrets: [], errors: [], resolvedValues: [] };
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

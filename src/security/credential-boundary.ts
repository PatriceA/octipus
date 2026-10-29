import { ToolPolicyRefusalError } from '@/core/tool-execution-error';

/** Vault references are selectors, never a general-purpose templating language.
 * Arbitrary tools (especially shell, files and remote MCP servers) must not
 * receive resolved credentials. Authenticated integrations resolve named
 * credentials inside their trusted client, with their own authorization.
 */
export function assertNoCredentialTemplates(value: unknown): void {
  const seen = new WeakSet<object>();
  function visit(input: unknown): void {
    if (typeof input === 'string') {
      if (/\{\{\s*secret\s*:/i.test(input) || /\$\{\s*vault\s*\./i.test(input)) {
        throw new ToolPolicyRefusalError('credentials',
          'Vault interpolation is disabled in general tool arguments and persisted content. Policy credential-boundary blocks general interpolation. Use connections__list and connections__request (or connections__git_fetch/git_push) with a configured connection name; MCP credentials belong in operator-configured credentialConnection bindings. If no profile exists, report missing connection configuration rather than invalid credentials; do not put credential values in commands, files, URLs, plans or notes.');
      }
      return;
    }
    if (!input || typeof input !== 'object' || seen.has(input)) return;
    seen.add(input);
    for (const [key, child] of Object.entries(input)) {
      visit(key);
      visit(child);
    }
  }
  visit(value);
}

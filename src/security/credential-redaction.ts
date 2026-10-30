import { getVault } from './vault';

/** Defense in depth for known values and common encodings. This is not taint
 * tracking and cannot make arbitrary secret-bearing programs safe. General
 * tool injection must remain prohibited independently of this masker.
 */
export function credentialVariants(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).flatMap(value => [value,
    JSON.stringify(value).slice(1, -1), encodeURIComponent(value),
    Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex'),
  ]))].sort((a, b) => b.length - a.length);
}

/** Password components can be reflected independently by a database driver.
 * Names and database identifiers remain useful diagnostics, not credentials.
 */
export function databaseCredentialValues(dsn: string): string[] {
  const values = [dsn];
  try {
    const url = new URL(dsn);
    if (url.password) {
      values.push(url.password);
      try { values.push(decodeURIComponent(url.password)); } catch { /* malformed URI: mask its literal component */ }
    }
    for (const [name, value] of url.searchParams) {
      if (value && /^(?:password|passwd|pwd|pass|sslpassword|ssl_password|sslkey_password)$/i.test(name)) values.push(value);
    }
  } catch { /* Invalid DSNs are still masked in their entirety. */ }
  return [...new Set(values)];
}

export function redactCredentialData(value: unknown, secrets: string[]): unknown {
  const variants = credentialVariants(secrets);
  function visit(input: unknown, seen: WeakSet<object>): unknown {
    if (typeof input === 'string') {
      let result = input;
      for (const needle of variants) result = result.split(needle).join('[REDACTED_CREDENTIAL]');
      return result;
    }
    if (input === null || input === undefined || typeof input === 'number' || typeof input === 'boolean') return input;
    if (input instanceof Date) return input.toISOString();
    if (typeof input !== 'object' || seen.has(input)) throw new Error('Unsupported credential-bearing response');
    seen.add(input);
    try {
      if (input instanceof Error) return visit({ name: input.name, message: input.message, ...('cause' in input ? { cause: input.cause } : {}) }, seen);
      if (Array.isArray(input)) return input.map(child => visit(child, seen));
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('Unsupported credential-bearing response');
      return Object.fromEntries(Object.entries(input).map(([key, child]) => [visit(key, seen) as string, visit(child, seen)]));
    } finally { seen.delete(input); }
  }
  return visit(value, new WeakSet());
}

/** Server-side diagnostic redaction is a separate purpose from authorizing an
 * agent to consume a credential. Values never leave this function. Fail closed
 * if the vault is unavailable; do not return unmasked history as a fallback.
 */
export async function redactAgentDiagnostics(userId: string, workspaceId: string | null, data: unknown): Promise<unknown> {
  const vault = getVault();
  const values: string[] = [];
  for (const owner of [userId, 'system']) {
    for (const entry of await vault.list(owner, { workspaceId })) {
      const value = await vault.getByName(owner, entry.name, { workspaceId });
      if (value !== null) values.push(value);
    }
  }
  const masked=redactCredentialData(data, values);
  return vault.redactLoginDiagnostics(userId,workspaceId,masked);
}

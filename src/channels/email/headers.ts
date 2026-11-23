/**
 * The header checks of the email channel (docs/CHANNELS.md#email), pure:
 * the raw header block in order, mail that must never be answered (auto
 * replies, lists, bounces, our own), and whether the receiving server
 * authenticated the sender.
 *
 * `From` is forgeable, so it counts only when the receiving server says so:
 * the TOPMOST `Authentication-Results` header written under an authserv-id
 * the operator trusts (RFC 8601) must report DMARC pass for the From domain,
 * or, without a DMARC result, a DKIM or SPF pass aligned with it. A header
 * further down, or under another id, may have come with the mail itself and
 * is ignored. No trusted header, or an unparsable one, is a failure: the
 * check fails closed.
 */

export interface HeaderLine {
  /** Lower-cased. */
  name: string;
  value: string;
}

/** The raw message's header block, unfolded, in order (topmost first). */
export function headerLines(raw: Buffer): HeaderLine[] {
  const text = raw.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const block = end >= 0 ? text.slice(0, end) : text;
  const lines: HeaderLine[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1].value += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    lines.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
  }
  return lines;
}

/** The raw header block, as the first part of `raw` (for parsing the addresses without the body). */
export function headerBlock(raw: Buffer): Buffer {
  const text = raw.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  // latin1 decodes one byte to one character: the index is the byte offset.
  return end >= 0 ? raw.subarray(0, end) : raw;
}

function all(lines: readonly HeaderLine[], name: string): string[] {
  return lines.filter((l) => l.name === name).map((l) => l.value);
}

/** The domain of an address, lower-cased; '' without one. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1).trim().toLowerCase().replace(/[>.]+$/, '') : '';
}

/** `<id>` tokens of a Message-ID / In-Reply-To / References value, in order. */
export function messageIds(value: string | null | undefined): string[] {
  return [...(value ?? '').matchAll(/<[^<>\s]{1,995}>/g)].map((m) => m[0]);
}

export type LoopReason = 'no_message_id' | 'own_address' | 'auto_submitted' | 'bulk' | 'mailing_list' | 'bounce';

/**
 * Why this mail must not be answered at all, or null. Auto replies
 * (`Auto-Submitted`, the vendor auto-reply headers), bulk and list mail,
 * bounces (an empty return path, a report, a mailer daemon) and mail from
 * the channel's own address: answering any of these is how mail loops start.
 */
export function loopReason(lines: readonly HeaderLine[], from: string, ownAddress: string): LoopReason | null {
  if (messageIds(all(lines, 'message-id')[0]).length !== 1) return 'no_message_id';
  if (from.toLowerCase() === ownAddress.toLowerCase()) return 'own_address';
  const local = from.slice(0, from.lastIndexOf('@')).toLowerCase();
  if (/^(mailer-daemon|postmaster)$/.test(local)) return 'bounce';
  if (all(lines, 'return-path').some((v) => /^<\s*>$/.test(v.trim()))) return 'bounce';
  if (all(lines, 'content-type').some((v) => /^multipart\/report\b/i.test(v.trim()))) return 'bounce';
  if (all(lines, 'auto-submitted').some((v) => v.trim().toLowerCase().split(/[;\s(]/)[0] !== 'no')) return 'auto_submitted';
  if (['x-autoreply', 'x-autorespond', 'x-auto-reply'].some((name) => all(lines, name).length > 0)) return 'auto_submitted';
  if (all(lines, 'precedence').some((v) => /^(bulk|list|junk|auto_reply)\b/i.test(v.trim()))) return 'bulk';
  if (['list-id', 'list-unsubscribe', 'list-post'].some((name) => all(lines, name).length > 0)) return 'mailing_list';
  return null;
}

/** How many addresses the `From` headers name together (exactly one is required). */
export function fromHeaderCount(lines: readonly HeaderLine[]): number {
  return all(lines, 'from').length;
}

// ── Authentication-Results (RFC 8601) ──────────────────────────────

export interface AuthResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

export interface AuthResults {
  authservId: string;
  results: AuthResult[];
}

/** Remove RFC 5322 comments `( … )`, nested ones included. */
function stripComments(value: string): string {
  let out = value;
  for (let previous = ''; previous !== out;) {
    previous = out;
    out = out.replace(/\([^()]*\)/g, ' ');
  }
  return out;
}

/** One `Authentication-Results` value, or null when it cannot be read. Pure. */
export function parseAuthenticationResults(value: string): AuthResults | null {
  const parts = stripComments(value).split(';').map((p) => p.trim());
  const authservId = (parts[0] ?? '').split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!authservId || authservId.includes('=')) return null;
  const results: AuthResult[] = [];
  for (const part of parts.slice(1)) {
    if (!part || part.toLowerCase() === 'none') continue;
    const tokens = part.split(/\s+/);
    const [methodRaw, resultRaw] = (tokens[0] ?? '').split('=');
    if (!methodRaw || !resultRaw) continue;
    const props: Record<string, string> = {};
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=');
      if (eq <= 0) continue;
      props[token.slice(0, eq).toLowerCase()] = token.slice(eq + 1).replace(/^"|"$/g, '').toLowerCase();
    }
    results.push({ method: methodRaw.split('/')[0].toLowerCase(), result: resultRaw.toLowerCase(), props });
  }
  return { authservId, results };
}

/**
 * Whether `domain` (the authenticated one) is aligned with the From domain:
 * the same, or the From domain a subdomain of it. A one-label domain (`com`)
 * never aligns.
 */
export function aligned(domain: string, fromDomain: string): boolean {
  const d = domain.toLowerCase().replace(/^@/, '');
  if (!d || !d.includes('.')) return false;
  return fromDomain === d || fromDomain.endsWith(`.${d}`);
}

export type AuthVerdict =
  | { ok: true; authservId: string; method: 'dmarc' | 'dkim' | 'spf' }
  | { ok: false; why: 'no_trusted_results' | 'dmarc_not_pass' | 'no_aligned_pass' };

/**
 * Did the receiving server authenticate mail from `fromDomain`? Reads only
 * the topmost `Authentication-Results` header whose authserv-id is in
 * `trustedIds`; the headers below it (which a sender can write) are never
 * looked at. A DMARC result decides when there is one (pass, for this From
 * domain); without one an aligned DKIM pass or SPF pass does.
 */
export function authenticationVerdict(lines: readonly HeaderLine[], fromDomain: string, trustedIds: readonly string[]): AuthVerdict {
  const trusted = new Set(trustedIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
  if (trusted.size === 0 || !fromDomain) return { ok: false, why: 'no_trusted_results' };
  let header: AuthResults | null = null;
  for (const value of all(lines, 'authentication-results')) {
    const parsed = parseAuthenticationResults(value);
    if (parsed && trusted.has(parsed.authservId)) {
      header = parsed;
      break;
    }
  }
  if (!header) return { ok: false, why: 'no_trusted_results' };
  const dmarc = header.results.filter((r) => r.method === 'dmarc');
  if (dmarc.length > 0) {
    const pass = dmarc.every((r) => r.result === 'pass' && r.props['header.from'] === fromDomain);
    return pass ? { ok: true, authservId: header.authservId, method: 'dmarc' } : { ok: false, why: 'dmarc_not_pass' };
  }
  const dkim = header.results.some((r) => r.method === 'dkim' && r.result === 'pass'
    && (aligned(r.props['header.d'] ?? '', fromDomain) || aligned(domainOf(r.props['header.i'] ?? ''), fromDomain)));
  if (dkim) return { ok: true, authservId: header.authservId, method: 'dkim' };
  const spf = header.results.some((r) => r.method === 'spf' && r.result === 'pass'
    && aligned(domainOf(r.props['smtp.mailfrom'] ?? '') || (r.props['smtp.mailfrom'] ?? ''), fromDomain));
  if (spf) return { ok: true, authservId: header.authservId, method: 'spf' };
  return { ok: false, why: 'no_aligned_pass' };
}

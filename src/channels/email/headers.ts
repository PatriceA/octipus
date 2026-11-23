/**
 * The header checks of the email channel (docs/CHANNELS.md#email), pure:
 * the raw header block in order, mail that must never be answered (auto
 * replies, lists, bounces, our own), and whether the receiving server
 * authenticated the sender.
 *
 * `From` is forgeable, so it counts only when the receiving server says so:
 * the TOPMOST `Authentication-Results` header written under an authserv-id
 * the operator trusts (RFC 8601) must report `dmarc=pass` with
 * `header.from` equal to the From domain. Nothing else counts: no DKIM or
 * SPF result on its own (their domains need alignment rules that are easy to
 * get wrong), no `header.i`, no other header. A header further down, or under
 * another id, may have come with the mail itself and is never read.
 *
 * The header is parsed by the RFC 8601 grammar — quoted strings, comments
 * only outside them, `method=result` then `reason=` / `ptype.property=`
 * tokens — and anything that does not fit makes the whole header unreadable,
 * which fails the check: sender-chosen values (a quoted local part in
 * `smtp.mailfrom`, a DKIM selector) can never be read as a result of their own.
 */
import { domainToASCII } from 'node:url';

export interface HeaderLine {
  /** Lower-cased. */
  name: string;
  value: string;
}

/** Thrown for a header block that is not well formed (a bare CR, which hides a header from some readers). */
export class MalformedHeaders extends Error {}

/** The raw message's header block, unfolded, in order (topmost first). Throws `MalformedHeaders` on a bare CR. */
export function headerLines(raw: Buffer): HeaderLine[] {
  const text = raw.toString('latin1');
  const end = text.search(/\r?\n\r?\n/);
  const block = end >= 0 ? text.slice(0, end) : text;
  if (/\r(?!\n)/.test(block)) throw new MalformedHeaders('bare CR in the header block');
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

/** A domain in ASCII (punycode) form, lower-cased; '' when it is not a valid domain name. */
export function asciiDomain(domain: string): string {
  const d = domain.trim().replace(/\.$/, '');
  if (!d || /[\s[\]@]/.test(d)) return '';
  return domainToASCII(d).toLowerCase();
}

/** The domain of an address in ASCII form, lower-cased; '' without a valid one. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? asciiDomain(address.slice(at + 1)) : '';
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

/** How many `From` headers the mail has (exactly one is required). */
export function fromHeaderCount(lines: readonly HeaderLine[]): number {
  return all(lines, 'from').length;
}

/**
 * The sender's address as the channel uses it: the one address mailparser
 * read, if it is a plain `local@domain` that appears as written in the raw
 * `From` header (so an encoded word or a display name that merely looks like
 * an address is never taken for it). Null otherwise.
 */
export function plainFromAddress(lines: readonly HeaderLine[], parsed: readonly string[]): string | null {
  if (parsed.length !== 1 || fromHeaderCount(lines) !== 1) return null;
  const address = parsed[0].trim();
  if (!/^[^\s@"<>()\[\]\\,;:]+@[^\s@"<>()\[\]\\,;:]+$/.test(address)) return null;
  const raw = all(lines, 'from')[0].toLowerCase();
  if (!raw.includes(address.toLowerCase()) || raw.includes('=?')) return null;
  return domainOf(address) ? address.toLowerCase() : null;
}

// ── Authentication-Results (RFC 8601) ──────────────────────────────

/** Longest `Authentication-Results` value read; a longer one is not trusted. */
export const MAX_AUTH_RESULTS_CHARS = 8192;

export interface AuthResult {
  method: string;
  result: string;
  reason?: string;
  props: Record<string, string>;
}

export interface AuthResults {
  authservId: string;
  results: AuthResult[];
}

type Token = { kind: 'atom' | 'quoted'; text: string; joined: boolean } | { kind: ';' | '=' };

/**
 * RFC 8601 tokens in one linear pass: atoms, quoted strings (with `\`
 * escapes), `;` and `=`. Comments `( … )`, nested, count as space and only
 * outside quotes. `joined` marks a token written right after the previous one
 * (no space), as in `"a"@b`. Null when unbalanced or unterminated.
 */
function tokenize(value: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  let spaced = true;
  while (i < value.length) {
    const c = value[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; spaced = true; continue; }
    if (c === '(') {
      let depth = 0;
      for (; i < value.length; i++) {
        const d = value[i];
        if (d === '\\') { i++; continue; }
        if (d === '(') depth++;
        else if (d === ')' && --depth === 0) { i++; break; }
      }
      if (depth !== 0) return null;
      spaced = true;
      continue;
    }
    if (c === ')') return null;
    if (c === ';' || c === '=') { tokens.push({ kind: c }); i++; spaced = false; continue; }
    if (c === '"') {
      let text = '';
      let closed = false;
      for (i++; i < value.length; i++) {
        const d = value[i];
        if (d === '\\') { text += value[++i] ?? ''; continue; }
        if (d === '"') { closed = true; i++; break; }
        text += d;
      }
      if (!closed) return null;
      tokens.push({ kind: 'quoted', text, joined: !spaced });
      spaced = false;
      continue;
    }
    let text = '';
    while (i < value.length && !/[\s;="()]/.test(value[i])) text += value[i++];
    tokens.push({ kind: 'atom', text, joined: !spaced });
    spaced = false;
  }
  return tokens;
}

const ATOM = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.@]+$/;
const METHOD = /^[a-z0-9][a-z0-9_-]*(\/[0-9]+)?$/i;
const RESULT = /^[a-z0-9_-]+$/i;
const PROPERTY = /^[a-z0-9_-]+\.[a-z0-9_.-]+$/i;

/** The id a header was written under, or null. Reads only up to the first `;`. */
export function authservIdOf(value: string): string | null {
  if (value.length > MAX_AUTH_RESULTS_CHARS) return null;
  const semi = value.indexOf(';');
  const head = tokenize(semi >= 0 ? value.slice(0, semi) : value);
  const first = head?.[0];
  return first && first.kind === 'atom' && ATOM.test(first.text) ? first.text.toLowerCase() : null;
}

/** One `Authentication-Results` value, or null when it does not follow RFC 8601. Pure, linear. */
export function parseAuthenticationResults(value: string): AuthResults | null {
  if (value.length > MAX_AUTH_RESULTS_CHARS) return null;
  const tokens = tokenize(value);
  if (!tokens || tokens.length === 0) return null;
  let at = 0;
  const next = () => tokens[at++];
  const peek = () => tokens[at];
  const id = next();
  if (id.kind !== 'atom' || !ATOM.test(id.text) || id.text.includes('=')) return null;
  const version = peek();
  if (version?.kind === 'atom' && /^[0-9]+$/.test(version.text)) at++;
  const results: AuthResult[] = [];
  // A value: an atom, a quoted string, or a quoted local part joined to `@domain`.
  const readValue = (): string | null => {
    const t = next();
    if (!t || (t.kind !== 'atom' && t.kind !== 'quoted')) return null;
    let text = t.kind === 'quoted' ? `"${t.text}"` : t.text;
    if (t.kind === 'atom' && !ATOM.test(t.text)) return null;
    const after = peek();
    if (t.kind === 'quoted' && after?.kind === 'atom' && after.joined && after.text.startsWith('@')) {
      if (!ATOM.test(after.text)) return null;
      text += after.text;
      at++;
    }
    return text;
  };
  let sawNone = false;
  while (at < tokens.length) {
    if (next().kind !== ';') return null;
    const method = next();
    if (!method) break; // a trailing ";"
    if (method.kind !== 'atom') return null;
    if (method.text.toLowerCase() === 'none' && (peek() === undefined || peek().kind === ';')) { sawNone = true; continue; }
    if (!METHOD.test(method.text) || next()?.kind !== '=') return null;
    const result = next();
    if (!result || result.kind !== 'atom' || !RESULT.test(result.text)) return null;
    const entry: AuthResult = { method: method.text.split('/')[0].toLowerCase(), result: result.text.toLowerCase(), props: {} };
    while (peek() && peek().kind !== ';') {
      const key = next();
      if (key.kind !== 'atom' || next()?.kind !== '=') return null;
      const val = readValue();
      if (val === null) return null;
      const name = key.text.toLowerCase();
      if (name === 'reason') entry.reason = val;
      else if (PROPERTY.test(name) && !(name in entry.props)) entry.props[name] = val.toLowerCase();
      else return null;
    }
    results.push(entry);
  }
  if (sawNone && results.length > 0) return null;
  return { authservId: id.text.toLowerCase(), results };
}

export type AuthVerdict =
  | { ok: true; authservId: string }
  | { ok: false; why: 'no_trusted_results' | 'unreadable' | 'no_dmarc' | 'dmarc_not_pass' };

/**
 * Did the receiving server authenticate mail from `fromDomain`? Reads only
 * the topmost `Authentication-Results` header written under one of
 * `trustedIds` (the id is compared before anything else is parsed); every
 * header below it is ignored. It must parse, carry a DMARC result, and every
 * DMARC result in it must be `pass` for exactly this From domain.
 */
export function authenticationVerdict(lines: readonly HeaderLine[], fromDomain: string, trustedIds: readonly string[]): AuthVerdict {
  const trusted = new Set(trustedIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
  const domain = asciiDomain(fromDomain);
  if (trusted.size === 0 || !domain) return { ok: false, why: 'no_trusted_results' };
  const value = all(lines, 'authentication-results').find((v) => {
    const id = authservIdOf(v);
    return id !== null && trusted.has(id);
  });
  if (value === undefined) return { ok: false, why: 'no_trusted_results' };
  const header = parseAuthenticationResults(value);
  if (!header) return { ok: false, why: 'unreadable' };
  const dmarc = header.results.filter((r) => r.method === 'dmarc');
  if (dmarc.length === 0) return { ok: false, why: 'no_dmarc' };
  const pass = dmarc.every((r) => r.result === 'pass' && asciiDomain(r.props['header.from'] ?? '') === domain);
  return pass ? { ok: true, authservId: header.authservId } : { ok: false, why: 'dmarc_not_pass' };
}

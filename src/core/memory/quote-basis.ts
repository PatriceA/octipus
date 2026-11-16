/**
 * The owner's own words behind a memory — pure checks, no database.
 *
 * Long-term memory learns only from what the owner typed. Every candidate fact
 * (from the per-turn extractor, the learning review or `remember_this`) carries
 * a verbatim `quote` and the ids of the messages it cites. A candidate is kept
 * only when one of those cited messages is the owner's own (`role='user'`, this
 * user, loaded by `owner-messages.ts`) and contains the quote after
 * normalisation. Assistant replies, tool output and compaction summaries are
 * never owner messages, so a claim that only they make has no quote to stand
 * on and is dropped.
 *
 * What this proves, and what it does not: the quoted words are the owner's.
 * It does not prove the fact written from them follows from them — "yes,
 * that's right" is a real quote that a careless extractor could hang a fact on.
 * The extractor is told the quote must state the fact on its own; the check
 * cannot enforce meaning.
 */

import { filterPII } from '@/core/agent/pii-filter';
import { MAX_SOURCE_QUOTE_CHARS, type MemoryStatus } from '@/db/schema/memories';
import type { CandidateFact } from './extractor';

/** Longest quote accepted from a model (the stored column's limit). */
export const MAX_QUOTE_CHARS = MAX_SOURCE_QUOTE_CHARS;
/** Shortest normalised quote: anything shorter matches almost every message. */
export const MIN_QUOTE_CHARS = 4;

/** A message the owner wrote: `role='user'`, in one of their own sessions. */
export interface OwnerMessage {
  id: string;
  text: string;
}

/** The verified evidence a stored memory carries. */
export interface QuoteBasis {
  /** The quote as the model gave it (trimmed). Redact with `storedQuote` before saving. */
  quote: string;
  /** Cited owner messages that contain the quote. Never empty. */
  sourceMessageIds: string[];
}

/** A candidate whose quote was found in the owner's own words. The judge accepts only these. */
export type VerifiedFact = CandidateFact & { basis: QuoteBasis; status: MemoryStatus };

export type QuoteRejection =
  | 'missing_quote'
  | 'quote_too_short'
  | 'quote_too_long'
  | 'quote_looks_secret'
  | 'no_owner_message'
  | 'quote_not_found';

const SINGLE_QUOTES = /[‘’‚‛′`´]/g;
const DOUBLE_QUOTES = /[“”„‟″«»]/g;
const DASHES = /[‐-―−﹘﹣－]/g;
const INVISIBLE = /[​-‍⁠﻿­]/g;

/**
 * Fold text for comparison: NFKC, accents and other marks stripped, case
 * folded, typographic quotes and dashes made plain, invisible characters
 * dropped, whitespace collapsed. Applied to both the quote and the message, so
 * "Café — “ok”" and "cafe - \"OK\"" compare equal.
 */
export function normalizeQuoteText(text: string): string {
  return text
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(INVISIBLE, '')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The quote as it is searched for: surrounding quote marks and ellipses a model adds are not part of it. */
function searchForm(quote: string): string {
  return normalizeQuoteText(quote).replace(/^["'.\s]+|["'.\s]+$/g, '');
}

// A credential spelled out: "my password is hunter2", "PIN: 4821".
const CREDENTIAL_DISCLOSURE = /\b(?:password|passwort|passphrase|passcode|pin|otp|cvv|cvc|security code|verification code|one[- ]time code|recovery code|2fa code)\b\s*(?:is|was|=|:)\s*\S+/i;
// Words that are only ever followed by a secret.
const SECRET_MATERIAL = /\b(?:seed phrase|recovery phrase|mnemonic phrase|private key)\b/i;
// An IBAN.
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/;

/**
 * Whether a quote looks like it carries a secret. Reuses the PII filter's
 * credential patterns (API keys, long hex tokens, card and social security
 * numbers) and adds spelled-out passwords, PINs and codes. Conservative: a
 * false positive costs one memory, a false negative stores a secret.
 */
export function quoteLooksSecret(quote: string): boolean {
  const pii = filterPII(quote);
  if (pii.redactions.some((r) => r.type === 'api_key' || r.type === 'credit_card' || r.type === 'ssn')) return true;
  return CREDENTIAL_DISCLOSURE.test(quote) || SECRET_MATERIAL.test(quote) || IBAN.test(quote);
}

/** Why a quote cannot be used, before looking at any message; null when it can. */
export function quoteRejection(quote: string | undefined | null): QuoteRejection | null {
  const trimmed = (quote ?? '').trim();
  if (!trimmed) return 'missing_quote';
  if (trimmed.length > MAX_QUOTE_CHARS) return 'quote_too_long';
  const folded = searchForm(trimmed);
  if (folded.length < MIN_QUOTE_CHARS || !/[\p{L}\p{N}]/u.test(folded)) return 'quote_too_short';
  if (quoteLooksSecret(trimmed)) return 'quote_looks_secret';
  return null;
}

export type QuoteVerdict =
  | { ok: true; basis: QuoteBasis }
  | { ok: false; reason: QuoteRejection };

/**
 * Check one quote against the messages it cites. `owner` holds only messages
 * already proven to be the owner's; a cited id missing from it (an assistant
 * reply, a tool row, another user's message, a made-up id) cannot support the
 * quote. Kept: the cited owner messages that contain it.
 */
export function checkQuoteBasis(
  quote: string | undefined | null,
  citedIds: readonly string[],
  owner: readonly OwnerMessage[],
): QuoteVerdict {
  const rejection = quoteRejection(quote);
  if (rejection) return { ok: false, reason: rejection };
  const byId = new Map(owner.map((m) => [m.id, m]));
  const cited = [...new Set(citedIds)].flatMap((id) => byId.get(id) ?? []);
  if (cited.length === 0) return { ok: false, reason: 'no_owner_message' };
  const needle = searchForm(quote as string);
  const containing = cited.filter((m) => normalizeQuoteText(m.text).includes(needle));
  if (containing.length === 0) return { ok: false, reason: 'quote_not_found' };
  return { ok: true, basis: { quote: (quote as string).trim(), sourceMessageIds: containing.map((m) => m.id) } };
}

/**
 * Split candidates into those the owner's words support and those they do not.
 * A fact cited from more than one owner message is `observed`; from one,
 * `tentative`.
 */
export function verifyQuotes<T extends CandidateFact>(
  candidates: readonly T[],
  owner: readonly OwnerMessage[],
): { accepted: Array<T & { basis: QuoteBasis; status: MemoryStatus }>; rejected: Array<{ candidate: T; reason: QuoteRejection }> } {
  const accepted: Array<T & { basis: QuoteBasis; status: MemoryStatus }> = [];
  const rejected: Array<{ candidate: T; reason: QuoteRejection }> = [];
  for (const candidate of candidates) {
    const verdict = checkQuoteBasis(candidate.quote, candidate.sourceMessageIds ?? [], owner);
    if (!verdict.ok) {
      rejected.push({ candidate, reason: verdict.reason });
      continue;
    }
    accepted.push({ ...candidate, basis: verdict.basis, status: verdict.basis.sourceMessageIds.length > 1 ? 'observed' : 'tentative' });
  }
  return { accepted, rejected };
}

/** The quote as stored: PII redacted (an email stays out of the row as it does out of the fact), within the column limit. */
export function storedQuote(quote: string): string {
  return filterPII(quote.trim()).filtered.slice(0, MAX_SOURCE_QUOTE_CHARS);
}

/** Exact-duplicate key for a fact's text: normalised, trailing punctuation ignored. */
export function factKey(content: string): string {
  return normalizeQuoteText(content).replace(/[\s.!?;:,]+$/, '');
}

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
 * What this proves, and what it does not: the quoted words are the owner's,
 * at least three words long, and share a content word with the fact (so "I
 * need" cannot carry "the user banks with EvilBank"). It does not prove the
 * fact follows from them — a quote that shares one word with an invented fact
 * still passes. The extractor is told the quote must state the fact on its
 * own; the check cannot enforce meaning.
 */

import { filterPII } from '@/core/agent/pii-filter';
import { MAX_SOURCE_QUOTE_CHARS, type MemoryStatus } from '@/db/schema/memories';
import type { CandidateFact } from './extractor';

/** Longest quote accepted from a model (the stored column's limit). */
export const MAX_QUOTE_CHARS = MAX_SOURCE_QUOTE_CHARS;
/** Shortest normalised quote: anything shorter matches almost every message. */
export const MIN_QUOTE_CHARS = 4;
/** Fewest words in a quote ("I need" is not evidence of anything). */
export const MIN_QUOTE_WORDS = 3;
/** Shortest word that counts as shared content between a quote and its fact. */
export const MIN_CONTENT_WORD_CHARS = 4;

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
  | 'quote_unrelated'
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

const segmenter = new Intl.Segmenter('und', { granularity: 'word' });

/** The words of a text, normalised. */
export function wordsOf(text: string): string[] {
  return [...segmenter.segment(normalizeQuoteText(text))].filter((s) => s.isWordLike).map((s) => s.segment);
}

// Words of four letters or more that say nothing about what a fact is about.
const STOPWORDS = new Set([
  'about', 'after', 'again', 'also', 'always', 'been', 'before', 'being', 'could', 'does', 'doing', 'done', 'each', 'even',
  'ever', 'from', 'have', 'having', 'here', 'into', 'just', 'like', 'make', 'many', 'more', 'most', 'much', 'must', 'need',
  'never', 'only', 'other', 'over', 'please', 'really', 'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them',
  'then', 'there', 'these', 'they', 'thing', 'things', 'this', 'those', 'very', 'want', 'were', 'what', 'when', 'where',
  'which', 'while', 'will', 'with', 'would', 'your', 'yours', 'user', 'users', 'theirs', 'myself', 'yourself',
]);

// Han, kana and Hangul words are short by nature; two characters already carry content.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function contentWords(text: string): string[] {
  return wordsOf(text).filter((w) =>
    (w.length >= MIN_CONTENT_WORD_CHARS || /^\p{N}{2,}$/u.test(w) || (w.length >= 2 && CJK.test(w))) && !STOPWORDS.has(w));
}

/** Same word, or one an inflection of the other ("prefers" / "prefer"); below four letters only an exact match. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_CONTENT_WORD_CHARS && long.startsWith(short);
}

/** Whether a quote and the fact written from it share at least one content word. */
export function quoteSupportsFact(quote: string, content: string): boolean {
  const factWords = contentWords(content);
  return contentWords(quote).some((q) => factWords.some((f) => sameWord(q, f)));
}

/** Why a quote cannot be used, before looking at any message; null when it can. */
export function quoteRejection(quote: string | undefined | null): QuoteRejection | null {
  const trimmed = (quote ?? '').trim();
  if (!trimmed) return 'missing_quote';
  if (trimmed.length > MAX_QUOTE_CHARS) return 'quote_too_long';
  const folded = searchForm(trimmed);
  if (folded.length < MIN_QUOTE_CHARS || wordsOf(trimmed).length < MIN_QUOTE_WORDS) return 'quote_too_short';
  if (quoteLooksSecret(trimmed)) return 'quote_looks_secret';
  return null;
}

export type QuoteVerdict =
  | { ok: true; basis: QuoteBasis }
  | { ok: false; reason: QuoteRejection };

/**
 * Check one quote against the fact written from it and the messages it cites.
 * `owner` holds only messages already proven to be the owner's; a cited id
 * missing from it (an assistant reply, a tool row, another user's message, a
 * made-up id) cannot support the quote. Kept: the cited owner messages that
 * contain it.
 */
export function checkQuoteBasis(
  quote: string | undefined | null,
  content: string,
  citedIds: readonly string[],
  owner: readonly OwnerMessage[],
): QuoteVerdict {
  const rejection = quoteRejection(quote);
  if (rejection) return { ok: false, reason: rejection };
  if (!quoteSupportsFact(quote as string, content)) return { ok: false, reason: 'quote_unrelated' };
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
    const verdict = checkQuoteBasis(candidate.quote, candidate.content, candidate.sourceMessageIds ?? [], owner);
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

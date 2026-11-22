/**
 * Recall's retrieval rules (docs/plans/recall-hardening.md §2): what is
 * searched, which candidates qualify, and which part of a passage is shown.
 * The selection itself is `selectRecallPassages` in kinds.ts; the rules it
 * applies are the pure functions here.
 *
 * The keyword leg matches ANY term of the query (`hybridSearchAnyTerm`), and
 * matching a term is no evidence of relevance, so a candidate qualifies only
 * under one of three rules (`qualifyHit`):
 *
 *   1. its cosine similarity reaches `minSimilarity`;
 *   2. it covers the message: at least `keywordCoverage` of the message's
 *      distinctive lexemes and at least two of them, with a cosine floor of
 *      `COVERAGE_COSINE_FLOOR × minSimilarity` when the query has an embedding;
 *   3. it contains an identifier from the message (an invoice number, a
 *      version, an error code).
 *
 * "Distinctive" is four characters or more, or holding a digit: a
 * language-independent stand-in for stopword removal, since `content_tsv`
 * uses the English configuration and a Dutch or German message keeps its
 * stopwords.
 */

export type QualifiedBy = 'similarity' | 'coverage' | 'identifier';

/** Rule 2's cosine floor, as a share of `minSimilarity`. */
export const COVERAGE_COSINE_FLOOR = 0.6;
/** Rule 2 needs at least this many of the message's distinctive lexemes, whatever the share. */
export const MIN_COVERED_LEXEMES = 2;

const HAS_DIGIT = /\p{N}/u;

/** Four characters or more, or holding a digit. */
export function isDistinctive(term: string): boolean {
  return [...term].length >= 4 || HAS_DIGIT.test(term);
}

/** The distinctive lexemes among `lexemes`, once each. */
export function distinctiveLexemes(lexemes: readonly string[]): string[] {
  return [...new Set(lexemes.filter(isDistinctive))];
}

/** How many of the message's distinctive lexemes a passage contains, and the share. */
export function lexicalCoverage(distinctive: readonly string[], matched: readonly string[]): { covered: number; of: number; share: number } {
  const have = new Set(matched);
  const covered = distinctive.filter((l) => have.has(l)).length;
  return { covered, of: distinctive.length, share: distinctive.length ? covered / distinctive.length : 0 };
}

/**
 * The identifiers in a message: tokens of four characters or more holding a
 * digit (`INV-2024-118`, `v2.3.1`, `E1234`, `2024`). Taken from the text, not
 * from the lexemes: the English parser splits `INV-2024-118` into `inv`,
 * `-2024` and `-118`, and a passage with `INV-2024-117` shares two of those.
 */
export function messageIdentifiers(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if ([...token].length >= 4 && HAS_DIGIT.test(token)) out.add(token.toLowerCase());
  }
  return [...out];
}

/** `content` holds `identifier` as a whole token (any case): `INV-2024-118` is not in `INV-2024-1180`. */
export function containsIdentifier(content: string, identifier: string): boolean {
  const hay = content.toLowerCase();
  const needle = identifier.toLowerCase();
  const wordChar = /[\p{L}\p{N}]/u;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at > 0 ? hay[at - 1] : '';
    const after = hay[at + needle.length] ?? '';
    if (!wordChar.test(before) && !wordChar.test(after)) return true;
  }
  return false;
}

export interface QualifyContext {
  /** The query's distinctive lexemes (`distinctiveLexemes`). */
  distinctive: readonly string[];
  /** The query's identifiers (`messageIdentifiers`). */
  identifiers: readonly string[];
  minSimilarity: number;
  keywordCoverage: number;
}

/**
 * Every rule `hit` qualifies under; empty: it does not. A null cosine (the
 * query could not be embedded) satisfies no similarity rule and sets no
 * floor: the keyword rules decide alone.
 */
export function qualifyHit(hit: { cosine: number | null; matchedLexemes: readonly string[]; content: string }, ctx: QualifyContext): QualifiedBy[] {
  const out: QualifiedBy[] = [];
  if (hit.cosine !== null && hit.cosine >= ctx.minSimilarity) out.push('similarity');
  const { covered, share } = lexicalCoverage(ctx.distinctive, hit.matchedLexemes);
  const floor = hit.cosine === null || hit.cosine >= COVERAGE_COSINE_FLOOR * ctx.minSimilarity;
  if (covered >= MIN_COVERED_LEXEMES && share >= ctx.keywordCoverage && floor) out.push('coverage');
  if (ctx.identifiers.some((id) => containsIdentifier(hit.content, id))) out.push('identifier');
  return out;
}

/**
 * The relative cut: hits more than `maxGap` below the best one are dropped.
 * It is about cosine, so only hits that qualified by similarity alone are cut,
 * and only they set the best: a passage that covers the message or names its
 * identifier stays whatever its cosine, and its cosine does not raise the bar
 * for the others. Order is kept; it only ever removes.
 */
export function relativeCut<T extends { cosine: number | null; qualifiedBy: readonly QualifiedBy[] }>(hits: readonly T[], maxGap: number): T[] {
  const bySimilarity = hits.filter((h) => h.qualifiedBy.includes('similarity') && h.cosine !== null);
  if (!bySimilarity.length) return [...hits];
  const best = Math.max(...bySimilarity.map((h) => h.cosine as number));
  return hits.filter((h) => !(h.qualifiedBy.length === 1 && h.qualifiedBy[0] === 'similarity' && (h.cosine as number) < best - maxGap));
}

// ── Query ───────────────────────────────────────────────────────────────────

/**
 * Below this many distinctive words a message is a follow-up ("and for
 * enterprise?", "what about INV-2024-119?"): it is searched with the previous
 * typed message. A self-contained short question gains little from the
 * extra words, a follow-up loses its subject without them.
 */
export const SHORT_QUERY_WORDS = 4;
/** The most characters searched. Longer text keeps its head and its tail. */
export const MAX_QUERY_CHARS = 2000;
/** Of a long text, the head kept; the rest of MAX_QUERY_CHARS goes to the tail, where the question after a paste is. */
export const QUERY_HEAD_CHARS = 500;
/** The previous message is context for a follow-up, not the question: at most this much of it. */
export const PREVIOUS_MESSAGE_CHARS = 500;

const ELISION = '\n…\n';

/** `text` within `max` characters: its first `head` and its last ones, cut on whitespace. */
export function headAndTail(text: string, max: number, head: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - ELISION.length);
  const headChars = Math.min(head, room);
  let start = text.slice(0, headChars);
  const space = start.search(/\s\S*$/);
  if (space > headChars * 0.6) start = start.slice(0, space);
  let end = text.slice(text.length - (room - headChars));
  const first = end.search(/\s/);
  if (first >= 0 && first < end.length * 0.4) end = end.slice(first);
  return `${start.trimEnd()}${ELISION}${end.trimStart()}`;
}

function distinctiveWords(text: string): string[] {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'._-]*/gu) ?? []).filter(isDistinctive);
}

/**
 * What recall searches for this message. A short one is searched together
 * with the previous typed message (no model call: recall must not add a
 * model round trip to every turn); a long one keeps its head and its tail.
 * A worker's brief (task and input) goes through the same trimming.
 */
export function buildRecallQuery(input: { query: string; previousMessage?: string }): string {
  const message = input.query.trim();
  const previous = input.previousMessage?.trim();
  if (previous && previous !== message && distinctiveWords(message).length < SHORT_QUERY_WORDS) {
    return headAndTail(`${headAndTail(previous, PREVIOUS_MESSAGE_CHARS, PREVIOUS_MESSAGE_CHARS / 2)}\n${message}`, MAX_QUERY_CHARS, QUERY_HEAD_CHARS);
  }
  return headAndTail(message, MAX_QUERY_CHARS, QUERY_HEAD_CHARS);
}

// ── Excerpt ─────────────────────────────────────────────────────────────────

/** The query's terms to look for in a passage: its distinctive words, lower case, once each. */
export function queryTerms(query: string): string[] {
  return [...new Set(distinctiveWords(query).map((w) => w.toLowerCase().replace(/[.'_-]+$/, '')))].filter(isDistinctive);
}

/**
 * A word of the passage matches a term by a shared stem: the term without
 * its last three letters, four at the least ("pricing" matches "prices"). A
 * term with a digit matches only itself.
 */
function matchesTerm(word: string, term: string): boolean {
  if (HAS_DIGIT.test(term)) return word === term;
  return word.startsWith(term.slice(0, Math.max(4, term.length - 3)));
}

/**
 * The `chars`-long window of `content` holding the most query terms (the
 * first such window on a tie), cut on word boundaries. Elision is marked: a
 * leading "… " when it does not start at the passage's start, a trailing " …"
 * when it stops before its end. Whitespace is collapsed first.
 */
export function excerptWindow(content: string, terms: readonly string[], chars: number): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= chars) return text;
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, word: m[0].toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') }));
  const hits = words.filter((w) => w.word && terms.some((t) => matchesTerm(w.word, t)));
  let start = 0;
  if (hits.length) {
    // The run of hits that fits in one window and is longest; ties keep the first.
    let best = { from: 0, to: 0 };
    for (let from = 0, to = 0; from < hits.length; from++) {
      if (to < from) to = from;
      while (to + 1 < hits.length && hits[to + 1].end - hits[from].at <= chars) to++;
      if (to - from > best.to - best.from) best = { from, to };
    }
    // Centre that run in the window, so the words before the first hit are shown too.
    const span = hits[best.to].end - hits[best.from].at;
    const lead = Math.floor(Math.max(0, chars - span) / 2);
    start = Math.max(0, Math.min(hits[best.from].at - lead, text.length - chars));
    // Back to the start of the word it falls in.
    start = words.find((w) => w.end > start)?.at ?? 0;
    if (start > hits[best.from].at) start = hits[best.from].at;
  }
  let end = start + chars;
  if (end < text.length) {
    // The last word that ends within the window.
    const last = [...words].reverse().find((w) => w.end <= end && w.at >= start);
    end = last ? last.end : end;
  } else {
    end = text.length;
  }
  return `${start > 0 ? '… ' : ''}${text.slice(start, end)}${end < text.length ? ' …' : ''}`;
}

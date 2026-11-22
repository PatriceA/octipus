/**
 * What the turn record can say about an answer without storing it
 * (docs/CONTEXT-HOOKS.md#measurement). Pure functions: the answer, the
 * passages' excerpts and the query are in memory only, on the turn handle,
 * and only the counts reach the row.
 *
 * "Used" (`passageUsed`): the answer repeats distinctive content of a
 * passage's excerpt that was not already in the query. Distinctive is what an
 * answer does not write by chance:
 *
 *   - strong: a number of three digits or more that is not a bare year
 *     (`2400`, `2,400`, `14:30`, `2024-05-01`), a token of four characters or
 *     more mixing letters and digits (`INV-2024-118`, `E1234`, `v2.3.1`), or,
 *     in a script written without spaces, a run of UNSPACED_RUN characters;
 *   - weak: a two-digit number, a bare year, or a word of LONG_WORD letters
 *     or more that is not among the common long words below (compared on
 *     its first STEM letters, so "renovation" matches "renovations").
 *
 * A passage counts as used with one strong token or two different weak ones.
 * One shared long word, or a year, is not enough.
 */

/** A word of this many letters or more is distinctive (weak). */
export const LONG_WORD = 8;
/** Long words compare on this many first letters. */
export const STEM = 7;
/** In an unspaced script, a shared run of this many characters is strong evidence. */
export const UNSPACED_RUN = 8;
/** Weak tokens a passage needs in the answer when it has no strong one. */
export const WEAK_TOKENS_NEEDED = 2;

/** Long words any answer may write whatever it read. */
const COMMON_LONG_WORDS = new Set([
  'information', 'everything', 'something', 'anything', 'important', 'different', 'following', 'including', 'available',
  'question', 'questions', 'possible', 'actually', 'probably', 'business', 'together', 'additional', 'according', 'currently',
  'generally', 'specific', 'specifically', 'required', 'provided', 'however', 'therefore', 'otherwise', 'although',
  'basically', 'customer', 'customers', 'document', 'documents', 'knowledge', 'recalled', 'retrieved', 'mentioned',
  'necessary', 'understand', 'regarding', 'whatever', 'whenever', 'yourself', 'themselves', 'complete', 'completed',
]);

const UNSPACED_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;
/** A token: letters and digits, joined by the separators of numbers, dates, codes and names. */
const TOKEN = /[\p{L}\p{N}](?:[\p{L}\p{N}]|[.,:/'’_-](?=[\p{L}\p{N}]))*/gu;
const DIGIT = /\p{Nd}/gu;
const LETTER = /\p{L}/u;
const NUMERIC = /^[\p{Nd}.,:/'’_-]+$/u;
const YEAR = /^(?:19|20)\d\d$/;

type Evidence = { kind: 'strong' | 'weak'; key: string };

/** A numeric token without its grouping marks or a zero decimal part: `2,400.00` and `2400` are one number. */
function canonicalNumber(token: string): string {
  return token.replace(/(?<=\p{Nd})[,'’_](?=\p{Nd})/gu, '').replace(/[.,]0+$/, '');
}

/** The distinctive tokens of `text`, each with the key it is compared on. */
function evidence(text: string): Evidence[] {
  const out: Evidence[] = [];
  const spaced = text.replace(UNSPACED_CHARS, ' ');
  for (const [raw] of spaced.matchAll(TOKEN)) {
    const token = raw.toLowerCase().replace(/’/g, "'");
    const digits = token.match(DIGIT)?.length ?? 0;
    if (NUMERIC.test(token)) {
      const n = canonicalNumber(token);
      if (digits >= 3 && !YEAR.test(n)) out.push({ kind: 'strong', key: n });
      else if (digits === 2 || YEAR.test(n)) out.push({ kind: 'weak', key: n });
    } else if (digits > 0) {
      if ([...token].length >= 4 && LETTER.test(token)) out.push({ kind: 'strong', key: token });
    } else if ([...token].length >= LONG_WORD && !COMMON_LONG_WORDS.has(token)) {
      out.push({ kind: 'weak', key: `w:${[...token].slice(0, STEM).join('')}` });
    }
  }
  return out;
}

/** The keys `text` holds, to look a token up in: its tokens' keys, and every key a long word could be compared on. */
function keysOf(text: string): Set<string> {
  const keys = new Set<string>();
  for (const [raw] of text.replace(UNSPACED_CHARS, ' ').matchAll(TOKEN)) {
    const token = raw.toLowerCase().replace(/’/g, "'");
    keys.add(NUMERIC.test(token) ? canonicalNumber(token) : token);
    if (!/\p{Nd}/u.test(token) && [...token].length >= STEM) keys.add(`w:${[...token].slice(0, STEM).join('')}`);
  }
  return keys;
}

/** Runs of an unspaced script in `excerpt`, UNSPACED_RUN long, that the answer repeats and the query does not hold. */
function sharedUnspacedRun(excerpt: string, answer: string, query: string): boolean {
  for (const [run] of excerpt.matchAll(UNSPACED_CHARS)) {
    const chars = [...run];
    for (let i = 0; i + UNSPACED_RUN <= chars.length; i++) {
      const window = chars.slice(i, i + UNSPACED_RUN).join('');
      if (answer.includes(window) && !query.includes(window)) return true;
    }
  }
  return false;
}

/** Whether `answer` repeats distinctive content of `excerpt` that `query` did not already hold (rule above). */
export function passageUsed(answer: string, excerpt: string, query: string): boolean {
  if (!answer.trim() || !excerpt.trim()) return false;
  if (sharedUnspacedRun(excerpt, answer, query)) return true;
  const inAnswer = keysOf(answer);
  const inQuery = keysOf(query);
  const weak = new Set<string>();
  for (const e of evidence(excerpt)) {
    if (!inAnswer.has(e.key) || inQuery.has(e.key)) continue;
    if (e.kind === 'strong') return true;
    weak.add(e.key);
    if (weak.size >= WEAK_TOKENS_NEEDED) return true;
  }
  return false;
}

/** How many of the shown passages the answer used. */
export function usedPassages(answer: string, passages: ReadonlyArray<{ excerpt: string; query: string }>): number {
  return passages.filter((p) => passageUsed(answer, p.excerpt, p.query)).length;
}

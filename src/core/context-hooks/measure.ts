/**
 * What the turn record can say about an answer without storing it
 * (docs/CONTEXT-HOOKS.md#measurement). Pure functions: the answer, the
 * passages' excerpts and the query are in memory only, on the turn handle,
 * and only the counts reach the row.
 *
 * Every text is compared in one form (`prep`): Unicode NFC, so a decomposed
 * "Ü" is the precomposed one, in lower case, with one apostrophe. Of an
 * answer only the first MAX_MEASURED_CHARS characters are read.
 *
 * "Used" (`passageUsed`): the answer repeats distinctive content of a
 * passage's excerpt that was not already in the query. Distinctive is what an
 * answer does not write by chance:
 *
 *   - strong: a number whose value has three digits or more and is not a
 *     bare year (`2400`, `2,400`, `2.400`, `1.000,50`, `2024-05-14`), a clock
 *     time off the quarter hour (`14:37`), a token of four characters or
 *     more mixing letters and digits (`INV-2024-118`, `E1234`, `v2.3.1`), or,
 *     in a script written without spaces, a run of UNSPACED_RUN characters;
 *   - weak: a number whose value has two digits, a bare year, a percentage
 *     that is not a multiple of five (`37%`), a word of LONG_WORD characters
 *     or more that is not among the common long words below (compared on its
 *     first STEM characters, so "renovation" matches "renovations"), or a Korean
 *     word of HANGUL_WORD syllables or more that is not a sentence-final
 *     predicate (compared on its first HANGUL_STEM syllables, so a noun
 *     matches with another particle).
 *
 * Not evidence at all: a number whose value has one digit (`5.00` is 5,
 * `1,00` is 1), a list item's number (`1.` or `2)` opening a line), a round
 * percentage (`50%`, `100%`), a time on the quarter hour (`10:00`, `14:30`).
 * A percentage is compared as one (`100%` is not `100`).
 *
 * A passage counts as used with one strong token or two different weak ones.
 * One shared long word, or a year, is not enough.
 *
 * "Named" (`citedItems`): the answer names a passage by its title, as a
 * whole word or phrase, or by its id. A title whose every word the query
 * already held ("Pricing" for "what is our pricing?") does not count by its
 * title: the answer repeats the question's topic either way.
 */

/** A word of this many characters or more is distinctive (weak). A combining mark (an Indic vowel sign, a virama) counts as one. */
export const LONG_WORD = 8;
/** Long words compare on this many first letters. */
export const STEM = 7;
/** A Korean word of this many syllables or more is distinctive (weak). */
export const HANGUL_WORD = 4;
/** Korean words compare on this many first syllables: a noun keeps them whatever particle follows. */
export const HANGUL_STEM = 3;
/** In an unspaced script, a shared run of this many characters is strong evidence. */
export const UNSPACED_RUN = 8;
/** Weak tokens a passage needs in the answer when it has no strong one. */
export const WEAK_TOKENS_NEEDED = 2;
/**
 * The characters of an answer that are read, for "used" and "named": a
 * longer answer is measured on its start. Bounds the work done on the
 * server's event loop when a turn finishes (up to `limit` passages each).
 */
export const MAX_MEASURED_CHARS = 20_000;

/** Long words any answer may write whatever it read. */
const COMMON_LONG_WORDS = new Set([
  'information', 'everything', 'something', 'anything', 'important', 'different', 'following', 'including', 'available',
  'question', 'questions', 'possible', 'actually', 'probably', 'business', 'together', 'additional', 'according', 'currently',
  'generally', 'specific', 'specifically', 'required', 'provided', 'however', 'therefore', 'otherwise', 'although',
  'basically', 'customer', 'customers', 'document', 'documents', 'knowledge', 'recalled', 'retrieved', 'mentioned',
  'necessary', 'understand', 'regarding', 'whatever', 'whenever', 'yourself', 'themselves', 'complete', 'completed',
]);

const UNSPACED_CHARS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;
/**
 * A token: letters and digits with the combining marks that belong to them
 * (vowel signs, viramas and the joiners of Indic scripts), joined by the
 * separators of numbers, dates, codes and names.
 */
const TOKEN = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}‌‍]|[.,:/'_-](?=[\p{L}\p{N}]))*/gu;
const DIGIT = /\p{Nd}/gu;
const LETTER = /\p{L}/u;
const NUMERIC = /^[\p{Nd}.,:/'_-]+$/u;
const YEAR = /^(?:19|20)\d\d$/;
const HANGUL = /^\p{Script=Hangul}+$/u;
/** A Korean sentence-final predicate (…니다, …세요, …다, …요): how a sentence ends, not what it is about. */
const HANGUL_PREDICATE = /[다요]$/u;
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** What may stand before a list item's number on its line. */
const LIST_LEAD = /(?:^|\n)[ \t\-*•>#(]*$/;

/** Every text here is compared in this form. */
export function prep(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/’/g, "'");
}

/** The start of an answer that is measured. */
const measured = (answer: string) => (answer.length > MAX_MEASURED_CHARS ? answer.slice(0, MAX_MEASURED_CHARS) : answer);

/**
 * The value of a number written with grouping marks or a decimal part, or
 * null when it is not one number. A grouping mark (`.`, `,`, `'`, `_`) stands
 * before exactly three digits, all of one kind; a decimal mark (`.` or `,`)
 * is the last mark, of another kind than the grouping, before one or two
 * digits (or four or more after a lone mark). One mark before exactly three
 * digits is read as grouping (`1.000` and `1,000` are 1000): that keeps every
 * digit, so the number never becomes a shorter one it is not. A zero decimal
 * part is dropped: `2,400.00`, `2.400` and `2400` are one number, `5.00` is 5.
 */
export function canonicalNumber(token: string): string | null {
  const parts = token.split(/([.,'_])/);
  const groups = parts.filter((_, i) => i % 2 === 0);
  const marks = parts.filter((_, i) => i % 2 === 1);
  if (!marks.length) return token;
  let intGroups = groups;
  let intMarks = marks;
  let frac = '';
  const last = marks[marks.length - 1];
  const tail = groups[groups.length - 1];
  const decimal = (last === '.' || last === ',')
    && !marks.slice(0, -1).includes(last)
    && (tail.length <= 2 || (marks.length === 1 && tail.length >= 4));
  if (decimal) {
    intGroups = groups.slice(0, -1);
    intMarks = marks.slice(0, -1);
    frac = tail.replace(/0+$/, '');
  }
  if (intMarks.length) {
    if (intMarks.some((m) => m !== intMarks[0])) return null;
    if (intGroups[0].length < 1 || intGroups[0].length > 3 || intGroups.slice(1).some((g) => g.length !== 3)) return null;
  }
  const int = intGroups.join('');
  return frac ? `${int}.${frac}` : int;
}

type Strength = 'strong' | 'weak' | null;
/** A token of a text: the key it is looked up by, how distinctive it is, and the stems a word can also be found by. */
interface Token { key: string | null; kind: Strength; stem?: string }

const digitCount = (s: string) => s.match(DIGIT)?.length ?? 0;

function numberToken(token: string, percent: boolean): Token {
  const clock = CLOCK.exec(token);
  if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) {
    const quarter = Number(clock[2]) % 15 === 0 && (!clock[3] || clock[3] === '00');
    return { key: `${Number(clock[1])}:${clock[2]}${clock[3] ? `:${clock[3]}` : ''}`, kind: quarter ? null : 'strong' };
  }
  const value = /[:/-]/.test(token) ? null : canonicalNumber(token);
  if (value === null) {
    // A date, a range, a code of digit groups: compared as written.
    const digits = digitCount(token);
    return { key: token, kind: digits >= 3 ? 'strong' : digits === 2 ? 'weak' : null };
  }
  if (percent) {
    const round = !value.includes('.') && Number(value) % 5 === 0;
    return { key: `${value}%`, kind: round ? null : 'weak' };
  }
  const digits = digitCount(value);
  return { key: value, kind: YEAR.test(value) ? 'weak' : digits >= 3 ? 'strong' : digits === 2 ? 'weak' : null };
}

/** The tokens of `text` (in `prep` form), each with its key and strength. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  const spaced = text.replace(UNSPACED_CHARS, ' ');
  for (const match of spaced.matchAll(TOKEN)) {
    const token = match[0];
    const end = match.index + token.length;
    if (NUMERIC.test(token)) {
      // A list item's number says where it is in a list, not what it read.
      if (/^\d{1,3}$/.test(token) && /^[.):](?:\s|$)/.test(spaced.slice(end, end + 2)) && LIST_LEAD.test(spaced.slice(Math.max(0, match.index - 40), match.index))) {
        out.push({ key: null, kind: null });
        continue;
      }
      out.push(numberToken(token, /^\s?%/.test(spaced.slice(end, end + 2))));
    } else if (digitCount(token) > 0) {
      out.push({ key: token, kind: [...token].length >= 4 && LETTER.test(token) ? 'strong' : null });
    } else if (HANGUL.test(token)) {
      const syllables = [...token];
      const stem = syllables.length >= HANGUL_STEM ? `h:${syllables.slice(0, HANGUL_STEM).join('')}` : undefined;
      const distinct = syllables.length >= HANGUL_WORD && !HANGUL_PREDICATE.test(token);
      out.push({ key: distinct && stem ? stem : token, kind: distinct ? 'weak' : null, ...(stem ? { stem } : {}) });
    } else {
      const chars = [...token];
      const stem = chars.length >= STEM ? `w:${chars.slice(0, STEM).join('')}` : undefined;
      const distinct = chars.length >= LONG_WORD && !COMMON_LONG_WORDS.has(token);
      out.push({ key: distinct && stem ? stem : token, kind: distinct ? 'weak' : null, ...(stem ? { stem } : {}) });
    }
  }
  return out;
}

/** The keys `text` (in `prep` form) holds, to look a token up in: its tokens' keys, and every stem a word could be compared on. */
function keysOf(text: string): Set<string> {
  const keys = new Set<string>();
  for (const t of tokens(text)) {
    if (t.key) keys.add(t.key);
    if (t.stem) keys.add(t.stem);
  }
  return keys;
}

/** Runs of an unspaced script in `excerpt`, UNSPACED_RUN long, that the answer repeats and the query does not hold (all in `prep` form). */
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

/** An answer read once, for every passage it is compared with. */
interface MeasuredAnswer { text: string; keys: Set<string> }

function measureAnswer(answer: string): MeasuredAnswer {
  const text = prep(measured(answer));
  return { text, keys: keysOf(text) };
}

function usedIn(answer: MeasuredAnswer, excerptRaw: string, queryRaw: string): boolean {
  if (!answer.text.trim() || !excerptRaw.trim()) return false;
  const excerpt = prep(excerptRaw);
  const query = prep(queryRaw);
  if (sharedUnspacedRun(excerpt, answer.text, query)) return true;
  const inQuery = keysOf(query);
  const weak = new Set<string>();
  for (const e of tokens(excerpt)) {
    if (!e.kind || !e.key || !answer.keys.has(e.key) || inQuery.has(e.key)) continue;
    if (e.kind === 'strong') return true;
    weak.add(e.key);
    if (weak.size >= WEAK_TOKENS_NEEDED) return true;
  }
  return false;
}

/** Whether `answer` repeats distinctive content of `excerpt` that `query` did not already hold (rule above). */
export function passageUsed(answer: string, excerpt: string, query: string): boolean {
  return usedIn(measureAnswer(answer), excerpt, query);
}

/** How many of the shown passages the answer used. */
export function usedPassages(answer: string, passages: ReadonlyArray<{ excerpt: string; query: string }>): number {
  const read = measureAnswer(answer);
  return passages.filter((p) => usedIn(read, p.excerpt, p.query)).length;
}

// ── Named ───────────────────────────────────────────────────────────────────

/** A title shorter than this (after its extension is stripped) is not counted as named: "AI" is in too many answers. */
export const MIN_TITLE_CHARS = 4;
const FILE_EXTENSION = /\.(md|markdown|txt|pdf|docx?)$/;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const UNSPACED_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const normal = (text: string) => prep(text).replace(/\s+/g, ' ');
const bareTitle = (title: string) => normal(title.trim()).replace(FILE_EXTENSION, '').trim();

/** The code point that ends just before `at` in `s`, or ''. */
function codePointBefore(s: string, at: number): string {
  if (at <= 0) return '';
  const low = s.charCodeAt(at - 1);
  return low >= 0xdc00 && low <= 0xdfff && at >= 2 ? s.slice(at - 2, at) : s[at - 1];
}

/** The code point that starts at `at` in `s`, or ''. */
function codePointAt(s: string, at: number): string {
  const cp = s.codePointAt(at);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function namesBare(hay: string, bare: string): boolean {
  const chars = [...bare];
  if (chars.length < MIN_TITLE_CHARS) return false;
  const needsBefore = !UNSPACED_CHAR.test(chars[0]);
  const needsAfter = !UNSPACED_CHAR.test(chars[chars.length - 1]);
  for (let at = hay.indexOf(bare); at >= 0; at = hay.indexOf(bare, at + 1)) {
    if (needsBefore && WORD_CHAR.test(codePointBefore(hay, at))) continue;
    if (needsAfter && WORD_CHAR.test(codePointAt(hay, at + bare.length))) continue;
    return true;
  }
  return false;
}

/**
 * Whether `text` names `title` on word boundaries: "Pricing" is named in
 * 'from the note "Pricing":' but not in "repricing" or "Pricings". A file
 * is named without its extension ("contract.pdf" by "the contract"). Any
 * script: the boundary is a letter, mark or digit of any language, and none
 * is asked for next to a character of a script written without spaces, where
 * a title sits inside a run of text. Reads the first MAX_MEASURED_CHARS
 * characters of `text`.
 */
export function namesTitle(text: string, title: string): boolean {
  return namesBare(normal(measured(text)), bareTitle(title));
}

/** Whether every word of `bare` (a title in `normal` form) is already in the query: then naming it repeats the question. */
function titleInQuery(bare: string, query: string): boolean {
  if (!query.trim()) return false;
  const q = normal(query);
  const runs = [...bare.matchAll(UNSPACED_CHARS)].map(([run]) => run);
  if (runs.some((run) => !q.includes(run))) return false;
  const inQuery = keysOf(q);
  const words = tokens(bare);
  return (runs.length > 0 || words.length > 0) && words.every((t) => (t.key !== null && inQuery.has(t.key)) || (t.stem !== undefined && inQuery.has(t.stem)));
}

/**
 * The items the answer names: by title (`namesTitle`), unless every word of
 * the title was in `query`, or by id.
 */
export function citedItems(response: string, items: ReadonlyArray<{ id: string; sourceId: string; title: string }>, query = ''): number {
  if (!response) return 0;
  const hay = normal(measured(response));
  return items.filter((item) => {
    const bare = bareTitle(item.title);
    if (namesBare(hay, bare) && !titleInQuery(bare, query)) return true;
    return hay.includes(item.id.toLowerCase()) || hay.includes(item.sourceId.toLowerCase());
  }).length;
}

// ── Calibration ─────────────────────────────────────────────────────────────

/**
 * The fewest searched runs a calibration warning is given on. Below it, a
 * run of similar questions (a day spent on one project) reads as a bar that
 * is wrong.
 */
export const CALIBRATION_MIN_RUNS = 30;
/** At or above this share of searched runs showing passages, the bar is likely too low. */
export const CALIBRATION_NEARLY_ALWAYS = 0.95;
/** At or below this share, the bar is likely too high for the embedding model. */
export const CALIBRATION_ALMOST_NEVER = 0.05;

/**
 * How a recall run counts towards calibration: `found` when the search found
 * passages to show (shown, or dropped afterwards for the budget or a failed
 * commit), `nothing` when nothing cleared the bar, null when the run says
 * nothing about the bar: skipped (a short message, no embedding model),
 * failed or timed out, or degraded to keywords (no cosine was compared).
 */
export function calibrationSample(run: { status: string; reason?: string; degraded?: string }): 'found' | 'nothing' | null {
  if (run.degraded) return null;
  if (run.status === 'injected') return 'found';
  if (run.status === 'abstained') return run.reason === 'over_budget' ? 'found' : 'nothing';
  if (run.status === 'skipped' && run.reason === 'budget_spent') return 'found';
  if (run.status === 'error' && run.reason === 'commit_failed') return 'found';
  return null;
}

/** Whether a recall hook's bar looks wrong over its searched runs, or null (also for a sample under CALIBRATION_MIN_RUNS). */
export function calibrationVerdict(found: number, searched: number): 'injects_nearly_always' | 'injects_almost_never' | null {
  if (searched < CALIBRATION_MIN_RUNS) return null;
  const share = found / searched;
  if (share >= CALIBRATION_NEARLY_ALWAYS) return 'injects_nearly_always';
  if (share <= CALIBRATION_ALMOST_NEVER) return 'injects_almost_never';
  return null;
}

/** The warning's text: what was seen, what it may mean, and the sweep as the way to check. */
export function calibrationMessage(hook: string, verdict: 'injects_nearly_always' | 'injects_almost_never', found: number, searched: number): string {
  const pct = Math.round((found / searched) * 100);
  return verdict === 'injects_nearly_always'
    ? `${hook} showed passages on ${pct}% of the ${searched} messages it searched. Its minSimilarity may be too low for your embedding model, so passages that do not help cost tokens on every turn. Run the threshold sweep below with your own questions and apply the value it recommends.`
    : `${hook} showed passages on ${pct}% of the ${searched} messages it searched. If your notes and documents cover what you ask, its minSimilarity is likely too high for your embedding model. Run the threshold sweep below with your own questions and apply the value it recommends.`;
}

// ── The threshold sweep ─────────────────────────────────────────────────────

/** The `minSimilarity` values the sweep tries unless asked for others: 0.20 to 0.80 in steps of 0.05. */
export const SWEEP_THRESHOLDS: readonly number[] = Array.from({ length: 13 }, (_, i) => Number((0.2 + i * 0.05).toFixed(2)));
/** The most values one sweep may try. */
export const MAX_SWEEP_THRESHOLDS = 21;

export interface SweepRow {
  minSimilarity: number;
  found: { n: number; of: number };
  abstained: { n: number; of: number };
}

/**
 * The value the sweep recommends: the one with the highest found-rate plus
 * abstained-rate (each answerable question finding its source counts as much,
 * in share, as each question that should find nothing being shown nothing);
 * on a tie the higher threshold, which shows less for the same score. None
 * without both kinds of question: with only answerable ones the lowest bar
 * always wins, with only should-find-nothing ones the highest.
 */
export function recommendThreshold(rows: readonly SweepRow[]): { recommended: number | null; reason?: 'needs_both_kinds' } {
  if (!rows.length || rows[0].found.of === 0 || rows[0].abstained.of === 0) return { recommended: null, reason: 'needs_both_kinds' };
  let best: { t: number; score: number } | null = null;
  for (const row of rows) {
    const score = row.found.n / row.found.of + row.abstained.n / row.abstained.of;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && row.minSimilarity > best.t)) best = { t: row.minSimilarity, score };
  }
  return { recommended: best?.t ?? null };
}

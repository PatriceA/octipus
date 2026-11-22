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
 *
 * "Named" (`citedItems`): the answer names a passage by its title, as a
 * whole word or phrase, or by its id.
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

// ── Named ───────────────────────────────────────────────────────────────────

/** A title shorter than this (after its extension is stripped) is not counted as named: "AI" is in too many answers. */
export const MIN_TITLE_CHARS = 4;
const FILE_EXTENSION = /\.(md|markdown|txt|pdf|docx?)$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const UNSPACED_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

const normal = (text: string) => text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ');

/**
 * Whether `text` names `title` on word boundaries: "Pricing" is named in
 * 'from the note "Pricing":' but not in "repricing" or "Pricings". A file
 * is named without its extension ("contract.pdf" by "the contract"). Any
 * script: the boundary is a letter or digit of any language, and none is
 * asked for next to a character of a script written without spaces, where
 * a title sits inside a run of text.
 */
export function namesTitle(text: string, title: string): boolean {
  const bare = normal(title.trim()).replace(FILE_EXTENSION, '').trim();
  const chars = [...bare];
  if (chars.length < MIN_TITLE_CHARS) return false;
  const hay = normal(text);
  const needsBefore = !UNSPACED_CHAR.test(chars[0]);
  const needsAfter = !UNSPACED_CHAR.test(chars[chars.length - 1]);
  for (let at = hay.indexOf(bare); at >= 0; at = hay.indexOf(bare, at + 1)) {
    const before = [...hay.slice(0, at)].pop() ?? '';
    const after = [...hay.slice(at + bare.length)][0] ?? '';
    if ((!needsBefore || !WORD_CHAR.test(before)) && (!needsAfter || !WORD_CHAR.test(after))) return true;
  }
  return false;
}

/** The items the answer names: by title (`namesTitle`) or by id. */
export function citedItems(response: string, items: ReadonlyArray<{ id: string; sourceId: string; title: string }>): number {
  if (!response) return 0;
  const text = response.toLowerCase();
  return items.filter((item) => namesTitle(response, item.title) || text.includes(item.id.toLowerCase()) || text.includes(item.sourceId.toLowerCase())).length;
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

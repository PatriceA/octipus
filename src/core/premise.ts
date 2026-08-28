/**
 * Premise checks — does the thing the brief talks about actually exist?
 *
 * A QA run asked a pipeline to fix a typo in a named file. The file was not in
 * the workspace. Rather than say so, the run CREATED the file (with a docstring
 * claiming it had been "seeded with a known typo"), fixed the typo it had just
 * written, and its QA stage certified the result. Three stages, all green, a
 * completed run, and nothing about it was true.
 *
 * The agent had no way to know: prose in a brief is not evidence, and "the file
 * qa-loop.py contains X" reads exactly the same whether or not the file is
 * there. So the framework checks it — cheaply, before the work starts — and
 * states the answer as fact in the brief. An agent told "this path does not
 * exist" can report that; an agent left to discover it usually invents instead.
 *
 * Deliberately conservative. It reports, it never blocks: a brief may legitimately
 * name a file it is about to create. Being wrong here costs one line of true
 * information in a prompt.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Extensions worth checking. An allowlist rather than "anything with a dot",
 * because prose is full of dotted tokens that are not paths — version numbers,
 * domains, `e.g.`, sentence ends.
 */
const PATH_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|' +
  'json|yaml|yml|toml|ini|env|conf|cfg|lock|' +
  'md|mdx|txt|csv|tsv|html|css|scss|xml|svg';

/**
 * A path-ish token: an optional directory prefix plus a name with one of the
 * known extensions. Backticks/quotes around it are stripped by the capture.
 */
const PATH_TOKEN = new RegExp(String.raw`(?:^|[\s"'\`(\[<])([\w./-]*[\w-]+\.(?:${PATH_EXTENSIONS}))\b`, 'gi');

/**
 * Verbs that make a missing path expected rather than wrong.
 *
 * "create `src/routes/widgets.ts` with a GET handler" is the most ordinary task
 * there is, and telling that agent its subject does not exist — with a
 * do-not-substitute directive attached — is a refusal risk on exactly the small
 * models this codebase targets. Matched within a short window before the token,
 * which is where the verb sits in real briefs.
 */
const CREATE_INTENT =
  /\b(create|creating|add|adding|write|writing|new|generate|generating|scaffold|scaffolding|author|authoring|make|making|produce|producing|introduce|introducing)\b[^.]{0,80}$/i;

/** Is this token introduced by a verb that expects it not to exist yet? */
function hasCreateIntent(text: string, matchIndex: number): boolean {
  return CREATE_INTENT.test(text.slice(Math.max(0, matchIndex - 100), matchIndex));
}

/** Things that look like paths but are never workspace files. */
function isNotAPath(token: string): boolean {
  return (
    token.includes('://') ||
    token.startsWith('..') ||
    /^\d+(\.\d+)+$/.test(token) ||
    // bare domains: no slash, and the "extension" is really a TLD-ish word
    (!token.includes('/') && /^[\w-]+\.(?:com|org|net|io|dev|cc|ai|sh|conf)$/i.test(token))
  );
}

export interface PremiseCheck {
  /** Paths named in the text that do exist under one of the roots. */
  present: string[];
  /** Paths named in the text that exist under none of them. */
  missing: string[];
}

/**
 * Cap on distinct tokens checked. Each one is a synchronous `existsSync` on a
 * spawn hot path; a brief that pastes a directory listing should not turn into
 * hundreds of stat calls. A real brief names a handful of files.
 */
const MAX_TOKENS = 24;

/**
 * Which paths named in `text` exist under any of `roots`.
 *
 * Absolute paths are checked as given. Relative ones are resolved against each
 * root in turn — a hit under any root counts as present, because a worker may
 * legitimately be pointed at more than one directory.
 */
/**
 * Does `candidate` sit inside `root`? Compared after resolution, so
 * `a/../../../etc/passwd` is rejected however it was spelled.
 */
function isInside(root: string, candidate: string): boolean {
  const base = resolve(root);
  return candidate === base || candidate.startsWith(base + sep);
}

export function checkNamedPaths(text: string, roots: string[]): PremiseCheck {
  const present: string[] = [];
  const missing: string[] = [];
  if (!text) return { present, missing };

  const usableRoots = roots.filter(Boolean);
  const seen = new Set<string>();

  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[1];
    if (!token || seen.has(token) || isNotAPath(token)) continue;
    seen.add(token);
    if (seen.size > MAX_TOKENS) break;
    // A path the task is asking to CREATE is supposed to be missing.
    if (hasCreateIntent(text, match.index ?? 0)) continue;

    // Only ever stat inside a root. The brief is written by a model or a user,
    // so an unconstrained `existsSync` would let its text probe arbitrary host
    // paths and read the answer back out of the rendered note — and a relative
    // token can climb out of the workspace just as easily as an absolute one can
    // point outside it. A token that resolves outside every root is not
    // checkable, so it is reported as neither present nor missing.
    const candidates = usableRoots
      .map((root) => (isAbsolute(token) ? resolve(token) : resolve(root, token)))
      .filter((abs, i) => isInside(usableRoots[i] as string, abs));
    if (candidates.length === 0) continue;

    const exists = candidates.some((abs) => existsSync(abs));
    (exists ? present : missing).push(token);
  }

  return { present, missing };
}

/**
 * The block to append to a brief, or null when there is nothing to say.
 *
 * Phrased as a fact plus the required behaviour, because the fact alone did not
 * stop the fabrication — the run that invented its own subject file would have
 * read "does not exist" and created it anyway without the second sentence.
 */
export function renderPremiseNote(check: PremiseCheck): string | null {
  if (check.missing.length === 0) return null;
  const list = check.missing.map((p) => `  - ${p}`).join('\n');
  return (
    `PREMISE CHECK (a fact from the framework, not an instruction from the requester):\n` +
    `These paths are named in your task and do not exist in your workspace right now:\n${list}\n` +
    `If the task is to CREATE them, that is expected — carry on.\n` +
    `If the task is to CHANGE something that should already be there ("fix", ` +
    `"update", "the file X contains…"), then its premise is wrong: report the path ` +
    `as missing and stop. Do not create a stand-in and work on that instead — it ` +
    `makes every check downstream meaningless.`
  );
}

/** Convenience: check `text` against `roots` and render the note in one call. */
export function premiseNoteFor(text: string, roots: string[]): string | null {
  return renderPremiseNote(checkNamedPaths(text, roots));
}

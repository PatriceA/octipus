/**
 * Every agent start is covered by the context hooks, or says why not
 * (docs/plans/recall-hardening.md §1).
 *
 * This suite reads every non-test source file under `src/`, finds each
 * `agentManager.spawn(` / `getAgentManager().spawn(` call and each
 * `directResponse(` call, and fails unless the site is in `SITES` below:
 * either hooked (the function named there calls `contextForAgentStart`) or
 * exempt with its reason. A site is named by its file and the function it
 * sits in, never by its line, so moving code does not break the suite; a new
 * start path cannot be added without someone deciding whether it gets the
 * user's knowledge.
 */
import { globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

type Call = 'spawn' | 'directResponse';

interface Site {
  file: string;
  /** The named function the call sits in (anonymous callbacks are looked through); `(module)` at top level. */
  within: string;
  call: Call;
  /** How many such calls that function holds: a second one is a new site. Default 1. */
  count?: number;
  /** Hooked: this function (default: `within`, same file) calls `contextForAgentStart`. */
  hooked?: { file?: string; within?: string; how: string };
  /** Not hooked on purpose, and why. */
  exempt?: string;
}

/**
 * The agent starts and how each gets its context hooks. Adding a start path?
 * Call `contextForAgentStart` (src/core/context-hooks/agent-start.ts) on it
 * and list it as `hooked`, or list it as `exempt` with the reason it needs
 * none. docs/CONTEXT-HOOKS.md lists the exemptions.
 */
const SITES: readonly Site[] = [
  {
    file: 'src/core/agent/root-runner.ts', within: 'runRootAgent', call: 'spawn',
    hooked: { file: 'src/core/agent/service.ts', within: 'runTurn', how: 'turn_start against the message, or the plan brief on "go"; runRootAgent is only called from runTurn' },
  },
  {
    file: 'src/core/agent/worker-spawner.ts', within: 'spawnWorkerRecorded', call: 'spawn',
    hooked: { how: 'worker_start against task and input, in the volatile tier of the worker prompt' },
  },
  {
    file: 'src/core/agent/worker-spawner.ts', within: 'respawnAndRun', call: 'spawn',
    exempt: 'retry or topic-backup respawn of a failed worker: it reruns the prompt spawnWorker assembled (respawnCtx.systemPrompt), block included',
  },
  {
    file: 'src/core/swarm/spawner.ts', within: 'singleSpawnAndRun', call: 'spawn',
    hooked: { within: 'spawnChildInner', how: 'worker_start against the brief, in the child\'s first message; every attempt (crash, backup, contract retry) reruns that message; a fork gets none of its own' },
  },
  {
    file: 'src/hooks/actions.ts', within: 'executeSpawnAgent', call: 'spawn',
    hooked: { how: 'the non-orchestrated hook agent: worker_start against its message, before the message' },
  },
  {
    file: 'src/api/routes/agents.ts', within: '(module)', call: 'spawn',
    hooked: { how: 'POST /api/agents with a message: worker_start against it, before the message' },
  },
  {
    file: 'src/core/agent/service.ts', within: 'runTurn', call: 'directResponse',
    exempt: 'the voice planning reply: spoken on the fast voice model, where the hooks\' deadline would be heard; the confirmed turn that follows is an ordinary turn and is hooked',
  },
  {
    file: 'src/core/gateway/message-handler.ts', within: 'answerSideQuestion', call: 'directResponse',
    hooked: { how: 'the side question: turn_start against the question, as directResponse\'s per-turn context' },
  },
];

// ── The scanner ─────────────────────────────────────────────────────────────

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'yield', 'await', 'else', 'do']);
const NOT_FUNCTIONS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'await', 'typeof', 'super', 'import']);

/**
 * `src` with comments and the text of strings, templates and regular
 * expressions blanked (same length, newlines kept), so a call or a brace in
 * a comment or a string is not code. A template's `${…}` stays code.
 */
function blankNonCode(src: string): string {
  const out = src.split('');
  const n = src.length;
  const stack: Array<'brace' | 'template'> = [];
  const wipe = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  const templateText = (from: number): number => {
    let j = from;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { wipe(from, j); return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') { wipe(from, j); stack.push('template'); return j + 2; }
      j++;
    }
    wipe(from, n);
    return n;
  };
  const regexAllowed = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    if (k < 0) return true;
    if (/[(,=:[!&|?{};+\-*%<>~^]/.test(out[k])) return true;
    const word = /[A-Za-z_$]+$/.exec(out.slice(Math.max(0, k - 12), k + 1).join(''))?.[0];
    return !!word && KEYWORDS_BEFORE_REGEX.has(word);
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; wipe(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; wipe(i, end); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      wipe(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '`') { i = templateText(i + 1); continue; }
    if (c === '/' && regexAllowed(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (inClass) { if (src[j] === ']') inClass = false; } else if (src[j] === '[') inClass = true; else if (src[j] === '/') break;
        j++;
      }
      wipe(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '{') stack.push('brace');
    if (c === '}' && stack.pop() === 'template') { i = templateText(i + 1); continue; }
    i++;
  }
  return out.join('');
}

/** Each `{` of `code` with its matching `}`. */
function braceBlocks(code: string): Array<{ open: number; close: number }> {
  const blocks: Array<{ open: number; close: number }> = [];
  const opens: number[] = [];
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '{') opens.push(i);
    else if (code[i] === '}') { const open = opens.pop(); if (open !== undefined) blocks.push({ open, close: i }); }
  }
  return blocks;
}

const skipBack = (code: string, at: number) => { let k = at; while (k >= 0 && /\s/.test(code[k])) k--; return k; };
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{', '>': '<' };

/** The index of the bracket opening the one that closes at `close`. */
function openerOf(code: string, close: number): number {
  const want = PAIRS[code[close]];
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    if (code[k] === code[close] && !(code[close] === '>' && code[k - 1] === '=')) depth++;
    else if (code[k] === want) { depth--; if (depth === 0) return k; }
  }
  return -1;
}

const identBefore = (code: string, end: number): string | undefined => /[A-Za-z_$][\w$]*$/.exec(code.slice(Math.max(0, end - 80), end + 1))?.[0];

/**
 * What the block opening at `open` is: a function body with its name, an
 * anonymous function's body (`null`), or no function body (`undefined`).
 */
function functionAt(code: string, open: number): string | null | undefined {
  let j = skipBack(code, open - 1);
  let arrow = false;
  if (code[j] === '>' && code[j - 1] === '=') { arrow = true; j = skipBack(code, j - 2); }
  let paramsClose = -1;
  if (code[j] === ')') paramsClose = j;
  else if (arrow && /[\w$]/.test(code[j])) {
    // `x => {`: a single bare parameter.
    const param = identBefore(code, j) ?? '';
    return nameOfArrow(code, skipBack(code, j - param.length));
  } else {
    // A return type between the parameters and the body: back to `): `.
    let depth = 0;
    for (let k = j; k >= 0; k--) {
      const ch = code[k];
      if (')]}>'.includes(ch) && !(ch === '>' && code[k - 1] === '=')) depth++;
      else if ('([{<'.includes(ch)) { depth--; if (depth < 0) return undefined; }
      else if (depth === 0 && (ch === ';' || (ch === '=' && code[k + 1] !== '>'))) return undefined;
      else if (depth === 0 && ch === ':') { const p = skipBack(code, k - 1); if (code[p] === ')') { paramsClose = p; break; } }
    }
    if (paramsClose < 0) return undefined;
  }
  const paramsOpen = openerOf(code, paramsClose);
  if (paramsOpen < 0) return undefined;
  let k = skipBack(code, paramsOpen - 1);
  if (code[k] === '>') { const lt = openerOf(code, k); if (lt < 0) return undefined; k = skipBack(code, lt - 1); }
  if (arrow) {
    const word = identBefore(code, k);
    if (word === 'async') k = skipBack(code, k - word.length);
    return nameOfArrow(code, k);
  }
  const name = identBefore(code, k);
  if (!name) return undefined;
  if (name === 'function') return nameOfArrow(code, skipBack(code, k - name.length));
  if (NOT_FUNCTIONS.has(name)) return undefined;
  return name;
}

/** The name an arrow (or function expression) ending its head at `k` is given: `const NAME =`, `NAME:`; else anonymous. */
function nameOfArrow(code: string, k: number): string | null {
  const head = code.slice(Math.max(0, k - 200), k + 1);
  const assigned = /([A-Za-z_$][\w$]*)\s*(?::[^=;{}()]*)?=$/.exec(head);
  if (assigned && !head.endsWith('==') && !head.endsWith('!=')) return assigned[1];
  const property = /([A-Za-z_$][\w$]*)\s*:$/.exec(head);
  return property ? property[1] : null;
}

/** The named function holding `offset`, looking through anonymous callbacks and plain blocks; `(module)` at top level. */
function enclosingFunction(code: string, blocks: ReturnType<typeof braceBlocks>, offset: number): string {
  const around = blocks.filter((b) => b.open < offset && offset < b.close).sort((a, b) => b.open - a.open);
  for (const block of around) {
    const name = functionAt(code, block.open);
    if (typeof name === 'string') return name;
  }
  return '(module)';
}

/** Whether the function `name` of `code` (the whole file for `(module)`) calls `contextForAgentStart`. */
function callsHelper(code: string, blocks: ReturnType<typeof braceBlocks>, name: string): boolean {
  const call = /\bcontextForAgentStart\s*\(/g;
  if (name === '(module)') return call.test(code);
  return blocks.some((b) => functionAt(code, b.open) === name && /\bcontextForAgentStart\s*\(/.test(code.slice(b.open, b.close)));
}

const CALLS: Array<{ call: Call; pattern: RegExp }> = [
  { call: 'spawn', pattern: /(?:\bagentManager|\bgetAgentManager\(\s*\))\s*\.\s*spawn\s*\(/g },
  { call: 'directResponse', pattern: /(?<!function\s+)\bdirectResponse\s*\(/g },
];

interface FoundSite { file: string; within: string; call: Call; line: number }

function findSites(files: ReadonlyMap<string, string>): FoundSite[] {
  const found: FoundSite[] = [];
  for (const [file, src] of files) {
    const code = blankNonCode(src);
    const blocks = braceBlocks(code);
    for (const { call, pattern } of CALLS) {
      for (const m of code.matchAll(pattern)) {
        const at = m.index ?? 0;
        found.push({ file, call, within: enclosingFunction(code, blocks, at), line: code.slice(0, at).split('\n').length });
      }
    }
  }
  return found;
}

/** Every problem with `sites` against `files`, each a sentence that says what to do. Empty: all covered. */
function checkSpawnSites(files: ReadonlyMap<string, string>, sites: readonly Site[]): string[] {
  const problems: string[] = [];
  const found = findSites(files);
  const key = (s: { file: string; within: string; call: Call }) => `${s.file} › ${s.within} › ${s.call}`;
  const how = 'Call contextForAgentStart (src/core/context-hooks/agent-start.ts) on that path and list it in SITES (src/core/context-hooks/spawn-sites.test.ts) as `hooked`, or list it there as `exempt` with the reason it starts without the user\'s knowledge.';
  const listed = new Map(sites.map((s) => [key(s), s]));
  const counts = new Map<string, FoundSite[]>();
  for (const f of found) counts.set(key(f), [...(counts.get(key(f)) ?? []), f]);

  for (const [k, at] of counts) {
    const site = listed.get(k);
    const where = at.map((a) => `${a.file}:${a.line}`).join(', ');
    if (!site) { problems.push(`New agent start ${k} (${where}) is neither hooked nor exempt. ${how}`); continue; }
    if (at.length !== (site.count ?? 1)) problems.push(`${k} holds ${at.length} ${site.call} call(s) (${where}); SITES expects ${site.count ?? 1}. A new call is a new agent start: decide for it, then update \`count\` or split the function.`);
  }
  for (const site of sites) {
    if (!counts.has(key(site))) problems.push(`SITES lists ${key(site)}, but no such call was found: the code moved or was removed. Update or remove the entry.`);
    if (!!site.hooked === !!site.exempt) { problems.push(`SITES entry ${key(site)} must be either hooked or exempt.`); continue; }
    if (site.exempt !== undefined && site.exempt.trim().length < 20) problems.push(`SITES entry ${key(site)} is exempt without a reason a reader can check.`);
    if (site.hooked) {
      const file = site.hooked.file ?? site.file;
      const within = site.hooked.within ?? site.within;
      const src = files.get(file);
      if (src === undefined) { problems.push(`SITES entry ${key(site)} is hooked in ${file}, which does not exist.`); continue; }
      const code = blankNonCode(src);
      if (!callsHelper(code, braceBlocks(code), within)) {
        problems.push(`${key(site)} is listed as hooked in ${file} › ${within}, but that function no longer calls contextForAgentStart. ${how}`);
      }
    }
  }
  return problems;
}

// ── The suite ───────────────────────────────────────────────────────────────

const ROOT = join(__dirname, '..', '..', '..');

function sourceFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const path of globSync('src/**/*.{ts,tsx}', { cwd: ROOT })) {
    if (/\.(test|spec)\.tsx?$/.test(path) || path.includes('test-helpers/') || path.endsWith('.d.ts')) continue;
    files.set(relative(ROOT, join(ROOT, path)).split('\\').join('/'), readFileSync(join(ROOT, path), 'utf8'));
  }
  return files;
}

describe('every agent start is covered by the context hooks', () => {
  test('each spawn and directResponse call in src/ is hooked or exempt with its reason', () => {
    const files = sourceFiles();
    expect(files.size).toBeGreaterThan(500);
    expect(checkSpawnSites(files, SITES)).toEqual([]);
  });

  test('the scan found the sites it is meant to see', () => {
    const found = findSites(sourceFiles()).map((f) => `${f.file} › ${f.within} › ${f.call}`).sort();
    expect(found).toEqual(SITES.map((s) => `${s.file} › ${s.within} › ${s.call}`).sort());
  });
});

describe('the checker', () => {
  const file = 'src/core/new-start.ts';

  test('a new unhooked spawn fails, naming the file, function and what to do', () => {
    const files = new Map([[file, [
      'export async function startReport(userId: string): Promise<{ id: string }> {',
      '  const agent = await getAgentManager().spawn({ userId });',
      '  return { id: agent.id };',
      '}',
    ].join('\n')]]);
    const problems = checkSpawnSites(files, []);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('src/core/new-start.ts › startReport › spawn (src/core/new-start.ts:2)');
    expect(problems[0]).toContain('contextForAgentStart');
    expect(problems[0]).toContain('exempt');
  });

  test('a second call in a listed function is a new site', () => {
    const files = new Map([[file, 'class A {\n  private async go() {\n    await this.agentManager.spawn({});\n    if (x) {\n      await agentManager.spawn({});\n    }\n  }\n}\n']]);
    const problems = checkSpawnSites(files, [{ file, within: 'go', call: 'spawn', exempt: 'a reason long enough to check' }]);
    expect(problems).toEqual([expect.stringContaining('holds 2 spawn call(s)')]);
  });

  test('a site listed as hooked fails once its function stops calling the helper', () => {
    const wired = 'const run = async (msg: string): Promise<string> => {\n  const hooks = await contextForAgentStart({ query: msg });\n  return directResponse(msg, hooks.text);\n};\n';
    const site = { file, within: 'run', call: 'directResponse' as const, hooked: { how: 'x' } };
    expect(checkSpawnSites(new Map([[file, wired]]), [site])).toEqual([]);
    const unwired = wired.replace('contextForAgentStart', 'somethingElse');
    expect(checkSpawnSites(new Map([[file, unwired]]), [site])).toEqual([expect.stringContaining('no longer calls contextForAgentStart')]);
  });

  test('an exemption needs a reason; a listed site that is gone is reported', () => {
    const files = new Map([[file, 'function a() { agentManager.spawn({}); }']]);
    expect(checkSpawnSites(files, [{ file, within: 'a', call: 'spawn', exempt: 'retry' }])).toEqual([expect.stringContaining('without a reason')]);
    expect(checkSpawnSites(files, [
      { file, within: 'a', call: 'spawn', exempt: 'a reason long enough to check' },
      { file, within: 'b', call: 'spawn', exempt: 'a reason long enough to check' },
    ])).toEqual([expect.stringContaining('no such call was found')]);
  });

  test('comments, strings, templates and regexes are not code; a template expression is', () => {
    const src = [
      '// agentManager.spawn( in a comment',
      '/* directResponse( in a block comment { */',
      "const a = 'agentManager.spawn(' + \"directResponse(\";",
      'const re = /agentManager\\.spawn\\(/g;',
      'const t = `agentManager.spawn( ${ helper({ x: 1 }) } }`;',
      'export function directResponse(m: string) { return m; }',
      'async function inner() { return `${await agentManager.spawn({})}`; }',
    ].join('\n');
    expect(findSites(new Map([[file, src]]))).toEqual([{ file, within: 'inner', call: 'spawn', line: 7 }]);
  });

  test('names a method, an arrow with a return type, a property and an anonymous callback\'s enclosing function', () => {
    const src = [
      'export class S {',
      '  private async single(opts: Parameters<S["x"]>[0], retry: boolean): Promise<{ ok: boolean }> {',
      '    try { await agentManager.spawn(opts); } catch (err) { throw err; }',
      '    const respawn = async (model: string): Promise<string> => {',
      '      await getAgentManager().spawn({ model });',
      '    };',
      '    return { ok: true };',
      '  }',
      '}',
      'export const routes = app.post("/", async ({ body }) => { await agentManager.spawn(body); });',
      'const handlers = { side: async (m: string) => { await directResponse(m); } };',
      'function outer() { items.forEach((i) => { void directResponse(i); }); }',
    ].join('\n');
    expect(findSites(new Map([[file, src]])).map((f) => [f.within, f.call])).toEqual([
      ['single', 'spawn'], ['respawn', 'spawn'], ['(module)', 'spawn'], ['side', 'directResponse'], ['outer', 'directResponse'],
    ]);
  });
});

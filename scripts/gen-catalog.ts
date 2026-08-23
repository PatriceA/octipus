#!/usr/bin/env bun
/**
 * Generate the architecture catalogs from the source, and gate them in CI.
 *
 * Our hand-written architecture docs drift measurably — the marketing site lags
 * the repo by about two weeks, its palette has diverged, and `docs/API.md` is a
 * hand-maintained table of a hundred-odd endpoints. Generated-plus-gated is the
 * only permanent fix for that class: the catalog is derived from the code, and
 * CI fails when the committed copy no longer matches what the code says.
 *
 * Three catalogs, because these are the three questions a newcomer (or an agent
 * reading the repo) asks that no single file answers today:
 *
 *   1. **HTTP surface** — every mounted route, with the method and the full
 *      path including the group prefix, plus any route object nothing mounts.
 *      That last one is the shape of the Prometheus endpoint whose unit test
 *      passed for months while the route was reachable by nobody.
 *   2. **Module graph** — which top-level `src/` module imports which, with
 *      edge counts and the mutual imports called out. We already have one.
 *   3. **Event matrix** — who publishes each gateway event type and which
 *      subscription patterns cover it. A produced type with no consumer is
 *      dead weight; a subscription no producer satisfies is a rename nobody
 *      finished.
 *
 * ## Why there is no AST here
 *
 * The obvious implementation walks the TypeScript AST. This repo is on
 * TypeScript 7, which is the Go port: it ships a compiler binary and no
 * JavaScript AST API at all, so `ts.createSourceFile` does not exist. Rather
 * than add a parser dependency for one script, this reads what the runtime
 * already gives us — `Bun.Transpiler.scan()` for imports, which is a real
 * parse — and falls back to narrow, anchored patterns for the two catalogs it
 * cannot get that way.
 *
 * Those patterns are honest about their limits. Anything that does not resolve
 * to a literal is COUNTED and reported, never dropped: a catalog that quietly
 * omits things is worse than no catalog, because it reads as coverage. If a
 * future route is registered in a shape this cannot see, the count moves, the
 * committed file changes, and CI says so.
 *
 * Every scan runs over a copy with comments blanked, so commented-out code
 * cannot read as live — which is the direction that would hide a defect rather
 * than invent one.
 *
 * Usage:
 *   bun run catalog           # write docs/architecture/generated/CATALOG.md
 *   bun run catalog:check     # exit 1 if the committed copy is stale
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SRC = join(REPO_ROOT, 'src');
const ROUTES_DIR = join(SRC, 'api/routes');
const SERVER_FILE = join(SRC, 'api/server.ts');
const OUT = join(REPO_ROOT, 'docs/architecture/generated/CATALOG.md');

/** Every non-test `.ts` under `dir`. Tests describe the code, they are not it. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
    if (name.includes('.test.') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out.sort();
}

/**
 * Index just past the `(` of a call, scanning to its matching `)`.
 *
 * Skips string and template literals, both comment forms, and regex literals,
 * which is what makes this usable on real source rather than a toy — a regex
 * holding an unbalanced paren would otherwise run the depth count off the end.
 */
export function matchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    // A regex literal is stepped over whole. Without this, `/['"]/` reads as a
    // `/` followed by a quote and the scan runs to the NEXT quote anywhere in
    // the file, swallowing every route and mount in between — and reporting the
    // smaller number as if it were coverage, which CI would then lock in.
    if (c === '/' && startsRegex(text, i)) {
      let j = i + 1;
      let inClass = false;
      for (; j < text.length && text[j] !== '\n'; j++) {
        if (text[j] === '\\') {
          j++;
          continue;
        }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
      }
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      for (; i < text.length; i++) {
        if (text[i] === '\\') {
          i++;
          continue;
        }
        if (text[i] === quote) break;
      }
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Blank out comments, keeping every byte offset.
 *
 * Scanning raw text counted a commented-out `.use(metricsRoutes)` as a live
 * mount — which would have hidden the exact defect this catalog exists to
 * surface, since commenting a mount out is how a route stops being reachable in
 * the first place. Blanking rather than deleting keeps offsets aligned, so a
 * path or prefix can still be read back from the ORIGINAL text at the same
 * index once the blanked copy has confirmed the code is live.
 *
 * String contents are stepped over, not blanked: a `//` inside a string is not
 * a comment, and the quotes themselves are what the route patterns anchor on.
 *
 * Regex literals ARE recognised and stepped over, which matters more than it
 * sounds: `/['"]/` otherwise reads as a `/` followed by a quote, the scan runs
 * to the next quote anywhere in the file, and every comment in between goes
 * unexamined — so a commented-out mount inside that span reads as live, which
 * is the exact defect the HTTP catalog exists to surface.
 */
export function blankComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl < 0 ? text.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      blank(i, end);
      i = end - 1;
      continue;
    }
    // A regex literal is stepped over whole. Without this, `/['"]/` reads as a
    // `/` followed by a quote, and the scan runs to the NEXT quote anywhere in
    // the file — stepping over everything in between instead of examining it,
    // so a commented-out mount inside that span is never blanked and reads as
    // live. That is the defect the HTTP catalog exists to surface.
    if (c === '/' && startsRegex(text, i)) {
      let j = i + 1;
      let inClass = false;
      for (; j < text.length && text[j] !== '\n'; j++) {
        if (text[j] === '\\') {
          j++;
          continue;
        }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
      }
      i = j;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '\\') {
          j++;
          continue;
        }
        if (text[j] === quote) break;
      }
      i = j;
    }
  }
  return out.join('');
}

/**
 * Does a `/` at `idx` start a regex literal rather than a division?
 *
 * The standard lexical test: a regex can only appear where a VALUE may start,
 * so look back at the last significant character. After an operand — an
 * identifier, a number, a closing bracket — a `/` divides; after an operator,
 * an opening bracket, a comma or a `return`, it opens a regex.
 */
function startsRegex(text: string, idx: number): boolean {
  let i = idx - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;
  const prev = text[i];
  if ('(,=:[!&|?{};+-*%^~<>'.includes(prev)) return true;
  // `return /x/`, `typeof /x/`, `case /x/` — a word boundary before a value.
  const word = text.slice(Math.max(0, i - 9), i + 1).match(/([A-Za-z_$]+)$/);
  return word ? ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void'].includes(word[1]) : false;
}

// ── 1. HTTP surface ─────────────────────────────────────────────────────────

export interface Route {
  method: string;
  path: string;
  file: string;
}

const HTTP_METHODS = 'get|post|put|patch|delete|head|options|all|ws';
/** A route registration: `.get('/x'`, on a chain or straight off `new Elysia`. */
const ROUTE_RE = new RegExp(`\\.(${HTTP_METHODS})\\(\\s*(['"\`])(/[^'"\`]*)\\2`, 'g');
/** Where a route registration SITS, ignoring the (blanked) path literal. */
const ROUTE_PLACE_RE = new RegExp(`\\.(${HTTP_METHODS})\\(\\s*['"\`]`, 'g');
/**
 * A call that looks like a route registration whose path is NOT a literal.
 *
 * Two conditions, both needed. The first argument must be a template literal or
 * a bare identifier — a member expression is `map.get(params.id)`, not a route.
 * And a second argument must follow, because every Elysia registration takes a
 * handler while a cache read or a set removal takes one argument. Without that
 * second condition this counted thirty-three collection lookups as unresolved
 * routes — the same lie as omitting them, just in the other direction: a number
 * nobody can act on.
 */
const ROUTE_UNRESOLVED_RE = new RegExp(
  `\\.(${HTTP_METHODS})\\(\\s*(?:\`|[A-Za-z_$][\\w$]*\\s*[,)])`,
  'g',
);
/** `export const fooRoutes = new Elysia({ prefix: '/foo' })`, prefix optional. */
const INSTANCE_RE =
  /export\s+const\s+(\w+)\s*=\s*new\s+Elysia\(\s*(?:\{[^}]*?prefix:\s*['"`]([^'"`]*)['"`][^}]*\})?/g;

/**
 * Where each route object is mounted in `server.ts`.
 *
 * Mounts are either `.group('/api', app => app.use(X))` or a bare `app.use(X)`
 * outside any group (the hosted artifact pages). Bracket-matching each
 * `.group('<literal>'` gives the exact span it covers, so a `.use` inside it
 * gets that prefix — no guessing from line order.
 */
export function mountPrefixes(rawServerSource: string): Map<string, string> {
  // Comments blanked so a commented-out mount reads as absent, which is what it
  // is. Prefixes are read from the raw text, since blanking empties them.
  const serverSource = blankComments(rawServerSource);
  const rawGroupRe = /\.group\(\s*(['"`])([^'"`]*)\1/g;
  const prefixAt = new Map<number, string>();
  for (let m = rawGroupRe.exec(rawServerSource); m; m = rawGroupRe.exec(rawServerSource)) {
    prefixAt.set(m.index, m[2]);
  }
  const groups: Array<{ start: number; end: number; prefix: string }> = [];
  const groupRe = /\.group\(/g;
  for (let m = groupRe.exec(serverSource); m; m = groupRe.exec(serverSource)) {
    const prefix = prefixAt.get(m.index);
    if (prefix === undefined) continue; // a group whose path is not a literal
    const open = serverSource.indexOf('(', m.index);
    const end = matchingParen(serverSource, open);
    if (end > 0) groups.push({ start: open, end, prefix });
  }

  const out = new Map<string, string>();
  const useRe = /\.use\(\s*(\w+)\s*\)/g;
  for (let m = useRe.exec(serverSource); m; m = useRe.exec(serverSource)) {
    const at = m.index;
    // Innermost enclosing group wins; none means mounted at the root.
    let prefix = '';
    let best = Infinity;
    for (const g of groups) {
      if (at > g.start && at < g.end && g.end - g.start < best) {
        best = g.end - g.start;
        prefix = g.prefix;
      }
    }
    // First mount wins: a route object mounted twice (the artifact-page
    // fallback) is one surface, and the outer mount is the canonical one.
    if (!out.has(m[1])) out.set(m[1], prefix);
  }
  return out;
}

/** Is there a top-level comma in this argument list — i.e. a second argument? */
export function hasSecondArgument(args: string): boolean {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return true;
  }
  return false;
}

export function collectRoutes(): { routes: Route[]; unmounted: string[]; unresolved: number } {
  const mounts = mountPrefixes(readFileSync(SERVER_FILE, 'utf-8'));
  const routes: Route[] = [];
  const unmounted: string[] = [];
  let unresolved = 0;

  for (const file of sourceFiles(ROUTES_DIR)) {
    const raw = readFileSync(file, 'utf-8');
    if (!raw.includes('new Elysia')) continue;
    // Same reason as the server: a commented-out route is not a route, and a
    // path inside a doc comment is not a registration.
    const src = blankComments(raw);
    const rel = relative(REPO_ROOT, file);

    // Every exported instance in this file, with the offset it starts at, so a
    // route can be attributed to the instance it hangs off. Several files
    // export more than one (`orgs.ts` has both the `/me/orgs` and the
    // `/admin/orgs` surfaces).
    const instances: Array<{ at: number; name: string; prefix: string }> = [];
    INSTANCE_RE.lastIndex = 0;
    for (let m = INSTANCE_RE.exec(raw); m; m = INSTANCE_RE.exec(raw)) {
      // Only count a declaration the blanked source also sees — otherwise one
      // inside a comment would register as a live instance.
      if (src.slice(m.index, m.index + 6).trim() !== 'export') continue;
      instances.push({ at: m.index, name: m[1], prefix: m[2] ?? '' });
    }
    for (const inst of instances) {
      if (!mounts.has(inst.name)) unmounted.push(`${inst.name} (${rel})`);
    }

    const owner = (at: number) => {
      let found: (typeof instances)[number] | undefined;
      for (const inst of instances) if (inst.at <= at) found = inst;
      return found;
    };

    // Registrations are found in the blanked text (so comments cannot add one)
    // and the path is read back from the raw text at the same offset.
    ROUTE_PLACE_RE.lastIndex = 0;
    for (let m = ROUTE_PLACE_RE.exec(src); m; m = ROUTE_PLACE_RE.exec(src)) {
      ROUTE_RE.lastIndex = m.index;
      const lit = ROUTE_RE.exec(raw);
      if (!lit || lit.index !== m.index) continue;
      const inst = owner(m.index);
      if (!inst) continue;
      const mount = mounts.get(inst.name);
      if (mount === undefined) continue; // unmounted — already reported above
      const sub = lit[3];
      routes.push({
        method: lit[1].toUpperCase(),
        path: `${mount}${inst.prefix}${sub === '/' ? '' : sub}` || '/',
        file: rel,
      });
    }

    ROUTE_UNRESOLVED_RE.lastIndex = 0;
    for (let m = ROUTE_UNRESOLVED_RE.exec(src); m; m = ROUTE_UNRESOLVED_RE.exec(src)) {
      if (!owner(m.index)) continue;
      const open = src.indexOf('(', m.index);
      const close = matchingParen(src, open);
      if (close < 0) continue;
      if (!hasSecondArgument(src.slice(open + 1, close))) continue;
      unresolved++;
    }
  }

  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return { routes, unmounted: [...new Set(unmounted)].sort(), unresolved };
}

// ── 2. Module graph ─────────────────────────────────────────────────────────

/** Top-level `src/` module a file belongs to (`src/core/x/y.ts` → `core`). */
export function moduleOf(file: string): string {
  const rel = relative(SRC, file);
  const top = rel.split('/')[0];
  return top.endsWith('.ts') || top.endsWith('.tsx') ? '(root)' : top;
}

/** Resolve an import specifier to a top-level module, or null if external. */
export function importTarget(spec: string, fromFile: string): string | null {
  if (spec.startsWith('@/')) return moduleOf(join(SRC, spec.slice(2)));
  if (spec.startsWith('.')) return moduleOf(resolve(dirname(fromFile), spec));
  return null; // a package, not one of ours
}

export function collectModuleGraph(): { edges: Map<string, Map<string, number>>; cycles: string[] } {
  // A real parse, not a pattern: the transpiler is already in the runtime and
  // reports static and dynamic imports alike.
  const transpiler = new Bun.Transpiler({ loader: 'tsx' });
  const edges = new Map<string, Map<string, number>>();

  for (const file of sourceFiles(SRC)) {
    const from = moduleOf(file);
    let imports: Array<{ path: string }>;
    try {
      imports = transpiler.scanImports(readFileSync(file, 'utf-8'));
    } catch {
      continue; // unparseable file — the typecheck lane owns that failure
    }
    for (const imp of imports) {
      const to = importTarget(imp.path, file);
      if (!to || to === from) continue;
      const row = edges.get(from) ?? new Map<string, number>();
      row.set(to, (row.get(to) ?? 0) + 1);
      edges.set(from, row);
    }
  }

  // Two-module cycles only. Deeper ones exist in any real graph and listing
  // them all is noise; a mutual import between two modules is the one worth
  // seeing, because it is what blocks an extraction.
  const cycles: string[] = [];
  for (const [from, row] of edges) {
    for (const to of row.keys()) {
      if (from < to && edges.get(to)?.has(from)) cycles.push(`${from} <-> ${to}`);
    }
  }
  return { edges, cycles: cycles.sort() };
}

// ── 3. Event matrix ─────────────────────────────────────────────────────────

export interface EventUse {
  type: string;
  file: string;
}

/**
 * `hub.publishEvent({ ... })` / `getGatewayHub().publishEvent({ ... })`.
 *
 * The receiver is part of the pattern on purpose. `Scheduler` has a private
 * method of the same name that publishes task lifecycle events onto a Redis
 * channel, and an earlier version of this file put `created` / `started` /
 * `failed` in the gateway matrix — a catalog that mixes two buses is worse than
 * one that omits the second, because it invites you to look for a gateway
 * subscriber that was never supposed to exist.
 */
const PUBLISH_RE =
  /\b(?:(?:hub|getGatewayHub\(\))\.publishEvent|(?:this\.)?eventBus\.publish)\(\s*\{/g;
/** The method name, so the payload's own paren can be found past any getter. */
const PUBLISH_FN_RE = /publishEvent|publish/;
/** The `type:` entry of a publish payload, capturing the whole value expression. */
const TYPE_KEY_RE = /(?:^|[\s,{])type:\s*([^\n,]+)/;
/** A same-file helper the `type:` value delegates to, e.g. `mapXType(event.type)`. */
const HELPER_CALL_RE = /^(\w+)\(/;
/** The declared union in `protocol.ts` — the contract both sides are held to. */
const EVENT_TYPE_UNION_RE = /export type GatewayEventType =([\s\S]*?);\n/;

/** `eventBus.subscribe('pattern'` — not Redis pub/sub, not a UI store. */
const SUBSCRIBE_RE = /\beventBus\.subscribe\(\s*(['"`])([^'"`]+)\1/g;
const SUBSCRIBE_UNRESOLVED_RE = /\beventBus\.subscribe\(\s*(?!['"`])/g;

/** Every literal member of the `GatewayEventType` union, in declaration order. */
export function declaredEventTypes(protocolSource: string): string[] {
  const block = protocolSource.match(EVENT_TYPE_UNION_RE);
  if (!block) return [];
  return [...block[1].matchAll(/\|\s*'([^']+)'/g)].map((m) => m[1]);
}

/**
 * String literals a `type:` value can evaluate to.
 *
 * Three shapes, in order of how often they occur here: a plain literal; a
 * ternary or `||` chain whose branches are literals (`event.type === 'action'
 * ? 'agent.action' : 'agent.event'`); and a call into a same-file helper that
 * switches over literals (`mapOrchestratorEventType(event.type)`, which is how
 * nine of the declared types are actually emitted).
 *
 * One hop, deliberately. Following a helper across files would need real module
 * resolution, and the point of this function is not to be a type checker — it
 * is to stop the catalog claiming a type has no producer when it plainly does.
 * Anything it cannot resolve is counted as unresolved and reported.
 *
 * Indirect results are filtered against the declared union, direct ones are
 * not. A literal written at the publish site that the union does not carry is a
 * real finding; a literal swept up from an indirect expression is just as
 * likely to be the operand it was compared against — `const subtype =
 * event.type === 'action' ? 'agent.action' : 'agent.event'` yields three
 * strings and only two of them are event types.
 */
export function resolveEventTypes(valueExpr: string, fileSource: string, declared: string[] = []): string[] {
  const direct = [...valueExpr.matchAll(/(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
  if (direct.length > 0) return [...new Set(direct)];

  const call = valueExpr.match(HELPER_CALL_RE);
  if (!call) {
    // A bare identifier: a local holding the literal, as in
    // `const subtype = x ? 'agent.action' : 'agent.event'`.
    if (!/^\w+$/.test(valueExpr)) return [];
    const declRe = new RegExp(`\\b(?:const|let|var)\\s+${valueExpr}\\s*=\\s*([^\\n;]+)`);
    const decl = fileSource.match(declRe);
    if (!decl) return [];
    const found = [...new Set([...decl[1].matchAll(/(['"\`])([^'"\`]+)\1/g)].map((mm) => mm[2]))];
    return found.filter((t) => declared.includes(t));
  }
  const fnIdx = fileSource.search(new RegExp(`function\\s+${call[1]}\\s*\\(`));
  if (fnIdx < 0) return [];
  const bodyStart = fileSource.indexOf('{', fnIdx);
  if (bodyStart < 0) return [];
  // Brace-match the helper body so a later function's literals do not leak in.
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < fileSource.length; i++) {
    if (fileSource[i] === '{') depth++;
    else if (fileSource[i] === '}') {
      depth--;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  if (bodyEnd < 0) return [];
  const body = fileSource.slice(bodyStart, bodyEnd);
  const returned = [...new Set([...body.matchAll(/return\s+(['"`])([^'"`]+)\1/g)].map((m) => m[2]))];
  return returned.filter((t) => declared.includes(t));
}

export function collectEvents(): {
  declared: string[];
  produced: EventUse[];
  consumed: EventUse[];
  unresolved: number;
} {
  const declared = declaredEventTypes(readFileSync(join(SRC, 'core/gateway/protocol.ts'), 'utf-8'));
  const produced: EventUse[] = [];
  const consumed: EventUse[] = [];
  let unresolved = 0;

  for (const file of sourceFiles(SRC)) {
    // Blanked, for the same reason the route scan is: a commented-out
    // `hub.publishEvent({type:'x'})` would otherwise silence the
    // never-published gate for that type. It is not hypothetical — a doc
    // comment in `orchestrator/service.ts` mentions `eventBus.subscribe(...)`
    // and was being counted as an unresolvable subscribe site.
    const src = blankComments(readFileSync(file, 'utf-8'));
    const rel = relative(REPO_ROOT, file);

    PUBLISH_RE.lastIndex = 0;
    for (let m = PUBLISH_RE.exec(src); m; m = PUBLISH_RE.exec(src)) {
      // The paren of `publishEvent`, NOT the first paren after the match —
      // `getGatewayHub().publishEvent({...})` opens one on the getter first,
      // and matching that one hands back an empty payload with no `type`.
      const fnAt = m[0].search(PUBLISH_FN_RE) + m.index;
      const open = src.indexOf('(', fnAt);
      const end = matchingParen(src, open);
      const body = end > 0 ? src.slice(open, end) : '';
      const t = body.match(TYPE_KEY_RE);
      const types = t ? resolveEventTypes(t[1].trim(), src, declared) : [];
      if (types.length === 0) unresolved++;
      for (const type of types) produced.push({ type, file: rel });
    }

    SUBSCRIBE_RE.lastIndex = 0;
    for (let m = SUBSCRIBE_RE.exec(src); m; m = SUBSCRIBE_RE.exec(src)) {
      consumed.push({ type: m[2], file: rel });
    }
    SUBSCRIBE_UNRESOLVED_RE.lastIndex = 0;
    for (let m = SUBSCRIBE_UNRESOLVED_RE.exec(src); m; m = SUBSCRIBE_UNRESOLVED_RE.exec(src)) unresolved++;
  }
  return { declared, produced, consumed, unresolved };
}

/** Does a subscription pattern (`swarm.*`, `*`) cover this event type? */
export function patternCovers(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

// ── Rendering ───────────────────────────────────────────────────────────────

export function render(): string {
  const { routes, unmounted, unresolved: routeUnresolved } = collectRoutes();
  const { edges, cycles } = collectModuleGraph();
  const { declared, produced, consumed, unresolved: eventUnresolved } = collectEvents();

  const L: string[] = [];
  L.push('<!-- GENERATED by scripts/gen-catalog.ts — DO NOT EDIT. Run `bun run catalog` to refresh. -->');
  L.push('');
  L.push('# Architecture catalog');
  L.push('');
  L.push(
    'Derived from the source by `scripts/gen-catalog.ts` and verified in CI, so it cannot drift the way a hand-written architecture document does. Change the code, then regenerate.',
  );
  L.push('');

  L.push('## HTTP surface');
  L.push('');
  L.push(
    `${routes.length} mounted routes across ${new Set(routes.map((r) => r.file)).size} route files. The path is the full one, group prefix included — what a client actually calls.`,
  );
  L.push('');
  L.push('| Method | Path | Defined in |');
  L.push('|---|---|---|');
  for (const r of routes) L.push(`| ${r.method} | \`${r.path}\` | \`${r.file}\` |`);
  L.push('');
  if (unmounted.length > 0) {
    L.push('### Exported but never mounted');
    L.push('');
    L.push(
      'A route object nothing `.use`s is unreachable however green its own unit test is — the shape of the Prometheus endpoint that fed a registry nothing exposed.',
    );
    L.push('');
    for (const u of unmounted) L.push(`- \`${u}\``);
    L.push('');
  }
  if (routeUnresolved > 0) {
    L.push(
      `${routeUnresolved} route registration(s) do not use a literal path and are counted here rather than dropped.`,
    );
    L.push('');
  }

  L.push('## Module graph');
  L.push('');
  L.push('Imports between top-level `src/` modules, with the number of import sites on each edge.');
  L.push('');
  L.push('| From | Imports | Sites |');
  L.push('|---|---|---|');
  for (const from of [...edges.keys()].sort()) {
    const row = edges.get(from);
    if (!row) continue;
    for (const to of [...row.keys()].sort()) L.push(`| \`${from}\` | \`${to}\` | ${row.get(to)} |`);
  }
  L.push('');
  if (cycles.length > 0) {
    L.push('### Mutual imports');
    L.push('');
    L.push('Two modules that import each other. Not fatal, but it is what blocks an extraction.');
    L.push('');
    for (const c of cycles) L.push(`- ${c}`);
    L.push('');
  }

  L.push('## Event matrix');
  L.push('');
  L.push(
    'Every member of the `GatewayEventType` union in `src/core/gateway/protocol.ts`, against where it is published and which in-process subscription patterns cover it.',
  );
  L.push('');
  L.push(
    '"Covered by" means an **in-process** `eventBus.subscribe` pattern. WebSocket clients subscribe at runtime by sending their own patterns, so a row with no in-process subscriber is still delivered to a client that asked for it — it is not necessarily dead. What IS a defect is a declared type nothing publishes, and a subscription pattern no declared type satisfies.',
  );
  L.push('');
  const publishedTypes = [...new Set(produced.map((p) => p.type))];
  const allTypes = [...new Set([...declared, ...publishedTypes])].sort();
  L.push('| Event type | Declared | Published from | Covered by |');
  L.push('|---|---|---|---|');
  for (const type of allTypes) {
    const from = [...new Set(produced.filter((p) => p.type === type).map((p) => p.file))].sort();
    const by = [...new Set(consumed.filter((c) => patternCovers(c.type, type)).map((c) => c.type))].sort();
    L.push(
      `| \`${type}\` | ${declared.includes(type) ? 'yes' : '**no**'} | ${from.length ? from.map((f) => `\`${f}\``).join(', ') : '—'} | ${by.length ? by.map((b) => `\`${b}\``).join(', ') : '—'} |`,
    );
  }
  L.push('');

  const neverPublished = declared.filter((t) => !publishedTypes.includes(t));
  if (neverPublished.length > 0) {
    L.push('### Declared but never published');
    L.push('');
    L.push(
      'The contract promises these and no code emits them. Each is either a type to retire or a producer nobody finished — a subscriber waiting on one waits forever. One exception is expected: a type published only by the gateway\'s own tests appears here because this scan excludes test files on purpose, since tests describe the code rather than being it.',
    );
    L.push('');
    for (const t of neverPublished) {
      const waiting = [...new Set(consumed.filter((c) => patternCovers(c.type, t)).map((c) => c.file))].sort();
      L.push(`- \`${t}\`${waiting.length ? ` — subscribed by ${waiting.map((f) => `\`${f}\``).join(', ')}` : ''}`);
    }
    L.push('');
  }

  const undeclared = publishedTypes.filter((t) => !declared.includes(t)).sort();
  if (undeclared.length > 0) {
    L.push('### Published but not declared');
    L.push('');
    for (const t of undeclared) L.push(`- \`${t}\``);
    L.push('');
  }

  const orphanSubs = [...new Set(consumed.map((c) => c.type))]
    .filter((p) => !allTypes.some((t) => patternCovers(p, t)))
    .sort();
  if (orphanSubs.length > 0) {
    L.push('### Subscriptions no event type satisfies');
    L.push('');
    for (const p of orphanSubs) {
      const where = [...new Set(consumed.filter((c) => c.type === p).map((c) => c.file))].sort();
      L.push(`- \`${p}\` — ${where.map((f) => `\`${f}\``).join(', ')}`);
    }
    L.push('');
  }
  if (eventUnresolved > 0) {
    L.push(
      `${eventUnresolved} publish/subscribe site(s) use a non-literal event type and are counted here rather than dropped.`,
    );
    L.push('');
  }

  return `${L.join('\n').trimEnd()}\n`;
}

// ── Entry ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const generated = render();
  if (process.argv.includes('--check')) {
    let committed = '';
    try {
      committed = readFileSync(OUT, 'utf-8');
    } catch {
      console.error(`Catalog missing: ${relative(REPO_ROOT, OUT)}. Run \`bun run catalog\`.`);
      process.exit(1);
    }
    if (committed !== generated) {
      console.error(
        `Catalog is stale: ${relative(REPO_ROOT, OUT)} no longer matches the source. Run \`bun run catalog\` and commit the result.`,
      );
      process.exit(1);
    }
    console.log('Catalog is current.');
  } else {
    // `--check` tells the reader to run this, and the directory is not in a
    // fresh clone until the first generate — so creating it is part of being
    // the recovery path, not a convenience.
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, generated);
    console.log(`Wrote ${relative(REPO_ROOT, OUT)}`);
  }
}

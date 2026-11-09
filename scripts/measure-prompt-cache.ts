#!/usr/bin/env tsx
/**
 * Measure Octipus's prompt-cache layout on the native Anthropic path.
 *
 * Builds the root agent's request bodies for four steps — user A turn 1,
 * user A turn 2, user B turn 1, user A turn 3 after a direct MCP tool appeared
 * — through the real assembly (`src/core/agent/root-request-fixture.ts`) and
 * `AnthropicProvider`'s native body builder, and reports per request: the
 * cache breakpoints and their TTLs, token counts per segment, the
 * byte-identities between steps the design relies on, and the cache reads and
 * writes the API should report.
 *
 *   npm run measure:cache -- --dry-run            # no network, ever
 *   npm run measure:cache -- --model claude-sonnet-5-5
 *   ANTHROPIC_API_KEY=... npm run measure:cache             # live plan + max cost, sends nothing
 *   ANTHROPIC_API_KEY=... npm run measure:cache -- --yes    # count, then send the 4 steps
 *
 * Dry run (`--dry-run`, and the default when ANTHROPIC_API_KEY is unset): no
 * network at all; token counts are the repo's `estimateTokens` heuristic,
 * labelled as an estimate.
 *
 * Live (ANTHROPIC_API_KEY set): without `--yes`, the plan and its estimated
 * maximum cost, and nothing is sent. With `--yes`: counts each prefix with
 * the free count_tokens endpoint, prints the maximum cost and stops if it is
 * over `--max-cost`, then sends the four steps through
 * `AnthropicProvider.complete()` (the product's own request path, fixed to
 * api.anthropic.com) with `max_tokens: 0` — prefill only, no output billed —
 * and compares `usage` with the prediction. At most 4 Messages requests and
 * 12 count_tokens requests are sent. ANTHROPIC_BASE_URL is never used: a base
 * URL without a key is refused, since it can point at a proxy that is not the
 * account whose cache this measures.
 *
 * See docs/DIRECT-PROVIDERS.md (Prompt caching) for how to read the output.
 */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    model: { type: 'string' },
    'max-tokens': { type: 'string', default: '0' },
    'max-cost': { type: 'string', default: '2' },
    'no-tool-search': { type: 'boolean', default: false },
    'fixture-tools': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Usage: npm run measure:cache -- [options]

  --dry-run          build and analyse the requests only, no network (the default without ANTHROPIC_API_KEY)
  --live             require live mode (fails without ANTHROPIC_API_KEY; live is the default with one)
  --yes              live: actually send (at most 4 billed Messages requests, each retried once on 429, + 12 count_tokens)
  --model <id>       model to measure (default claude-opus-5-5)
  --max-tokens <n>   max_tokens per request (default 0: prefill only, no output)
  --max-cost <usd>   refuse to send when the worst case exceeds this (default 2)
  --no-tool-search   measure with agent.nativeToolSearch off
  --fixture-tools    small fixture tools instead of the real root toolboxes`);
  process.exit(0);
}

// The product config validates secrets and a database URL at load. This
// script reads neither the database nor the vault; ephemeral values only
// satisfy validation, and an unroutable URL makes any accidental query fail.
const ephemeral = () => `measure-${randomBytes(24).toString('hex')}`;
process.env.LOG_LEVEL ??= 'error';
process.env.MASTER_KEY ??= ephemeral();
process.env.JWT_SECRET ??= ephemeral();
process.env.SESSION_SECRET ??= ephemeral();
process.env.DATABASE_URL ??= 'postgres://none:none@no-database-for-measure-prompt-cache.invalid:5432/none';
if (args['no-tool-search']) process.env.AGENT_NATIVE_TOOL_SEARCH = 'false';

const MODEL = args.model ?? 'claude-opus-5-5';
const MAX_MESSAGES_REQUESTS = 4;
const MAX_COUNT_REQUESTS = 12;
const API = 'https://api.anthropic.com/v1/';

function fail(message: string): never {
  console.error(`measure-prompt-cache: ${message}`);
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
const maxTokens = Number(args['max-tokens']);
const maxCostLimit = Number(args['max-cost']);
if (!Number.isInteger(maxTokens) || maxTokens < 0 || maxTokens > 64) fail('--max-tokens must be an integer from 0 to 64');
if (!Number.isFinite(maxCostLimit) || maxCostLimit <= 0) fail('--max-cost must be a positive number of dollars');

// Live whenever a key is present (sending still needs --yes); a dry run otherwise.
if (args.live && args['dry-run']) fail('--live and --dry-run exclude each other.');
if ((args.live || args.yes) && !apiKey) {
  if (process.env.ANTHROPIC_BASE_URL) {
    fail('ANTHROPIC_BASE_URL is set but ANTHROPIC_API_KEY is not. Refusing live mode: a base URL alone may route to a proxy or another account, not the API key whose cache this measures. Set ANTHROPIC_API_KEY (the base URL is ignored either way).');
  }
  fail('live mode needs ANTHROPIC_API_KEY. Run without --live/--yes for a dry run.');
}
if (args.yes && args['dry-run']) fail('--yes sends requests; it cannot be combined with --dry-run.');
const live = !args['dry-run'] && Boolean(apiKey);

const { getRoleConfig } = await import('@/core/agent/roles');
const { ROOT_ROLE } = await import('@/core/agent/types');
const { fixtureHandler } = await import('@/core/agent/root-request-fixture');
const { nativeMessagesEnabled, AnthropicProvider } = await import('@/models/providers/anthropic-provider');
const S = await import('./prompt-cache-scenario');
type ToolHandler = import('@/core/agent-base').ToolHandler;

if (!nativeMessagesEnabled()) fail('ANTHROPIC_NATIVE_MESSAGES=0 selects the OpenAI-compatible endpoint, which has no prompt caching. Unset it to measure.');

/** The root role's built-in toolboxes, real schemas, in the role's order (no DB, no MCP connections). */
async function rootBuiltins(): Promise<ToolHandler[]> {
  const role = getRoleConfig(ROOT_ROLE);
  if (args['fixture-tools']) return ['filesystem', 'shell', 'skill-distill', 'websearch', 'notes'].map((id) => fixtureHandler(`${id}__op`, id));
  const { discoverTools } = await import('@/tools/discovery');
  const byId = new Map((await discoverTools()).map(({ tool }) => [tool.id, tool]));
  const handlers: ToolHandler[] = [];
  for (const id of role.toolIds) {
    const tool = byId.get(id);
    if (id === 'mcp' || !tool) continue;
    try {
      await tool.initialize();
      handlers.push(...tool.getToolHandlers());
    } catch (err) {
      console.warn(`  (toolbox ${id} skipped: ${(err as Error).message})`);
    }
  }
  return handlers;
}

const role = getRoleConfig(ROOT_ROLE);
const steps = await S.buildScenario({ model: MODEL, builtins: await rootBuiltins(), coreToolIds: role.coreToolIds ?? [], maxTokens });
const analyses = steps.map((s) => S.analyzeBody(s.body));
const minCacheable = S.minCacheableTokens(MODEL);
const price = S.pricingFor(MODEL);

console.log(`Prompt-cache layout, native Anthropic path — model ${MODEL} (${args.model ? '--model' : 'default; the root model is routed per turn from the database, pass --model to match it'})`);
console.log(`  minimum cacheable prefix: ${minCacheable} tokens; tool search ${analyses[0].toolSearch ? 'on' : 'off'}; max_tokens ${maxTokens}; tools: ${args['fixture-tools'] ? 'fixtures' : 'real root toolboxes'}`);
console.log('');

// ── Token counts ──
let counted: number[][] | undefined;
let countedTotals: number[] | undefined;
const estimated = analyses.map(S.estimatedCumulative);

async function countTokens(body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${API}messages/count_tokens`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`count_tokens ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as { input_tokens: number }).input_tokens;
}

/** Count each step's prefix at every breakpoint and its whole prompt, memoised by prefix. */
async function countAll(): Promise<{ cumulative: number[][]; totals: number[] }> {
  const memo = new Map<string, number>();
  let calls = 0;
  const count = async (hash: string, body: Record<string, unknown>) => {
    const hit = memo.get(hash);
    if (hit !== undefined) return hit;
    if (++calls > MAX_COUNT_REQUESTS) throw new Error(`more than ${MAX_COUNT_REQUESTS} count_tokens requests needed`);
    const tokens = await countTokens(body);
    memo.set(hash, tokens);
    return tokens;
  };
  const cumulative: number[][] = [];
  const totals: number[] = [];
  for (const [s, a] of analyses.entries()) {
    const body = steps[s].body;
    // Only breakpoint positions are ever read; other blocks keep the estimate.
    const cum = [...estimated[s]];
    for (const bp of a.breakpoints) cum[bp] = await count(a.hashes[bp], S.prefixCountBody(body, a, bp));
    const { max_tokens: _m, stream: _s, ...whole } = body;
    totals.push(await count(`total:${a.hashes.at(-1)}`, whole));
    cumulative.push(cum);
  }
  return { cumulative, totals };
}

if (live && args.yes) {
  console.log('Counting prefixes with count_tokens (free)...');
  ({ cumulative: counted, totals: countedTotals } = await countAll());
  console.log('');
}

console.log(counted
  ? 'Token counts: count_tokens on each prefix cut at its breakpoint (a 1-token placeholder turn included).'
  : 'Token counts: ESTIMATES (the repo\'s estimateTokens heuristic, not the API tokenizer; live mode counts them).');
console.log('');
const unit = counted ? 'tok' : 'tok est.';
const cumulative = counted ?? estimated;
const expected = S.expectCache(analyses, cumulative, minCacheable, countedTotals);
for (const [i, step] of steps.entries()) {
  for (const line of S.formatStep(step, analyses[i], cumulative[i], expected[i], unit)) console.log(line);
  console.log('');
}
const checks = S.identityChecks(steps, analyses);
for (const line of S.formatChecks(checks)) console.log(line);
const failed = checks.filter((c) => !c.ok);
console.log('');

if (!live) {
  console.log(`Dry run: nothing sent. ${failed.length ? `${failed.length} check(s) FAILED.` : 'All checks passed.'}`);
  if (!apiKey) console.log('  No ANTHROPIC_API_KEY: live mode unavailable (ANTHROPIC_BASE_URL is never used).');
  else console.log('  To measure against the API: drop --dry-run (plan only), then add --yes to send.');
  process.exit(failed.length ? 1 : 0);
}

// ── Live ──
if (!price) fail(`no pricing for ${MODEL} in scripts/prompt-cache-scenario.ts (PRICING); known: ${Object.keys(S.PRICING).join(', ')}`);
const totals = countedTotals ?? expected.map((e) => Math.ceil(e.total * 1.3));
const worst = S.maxCost(totals, maxTokens, price);
const predicted = expected.reduce((sum, e) => sum + S.costOf(e, price), 0);
console.log(`Live plan: ${steps.length} Messages requests (cap ${MAX_MESSAGES_REQUESTS}) to ${API}messages, max_tokens ${maxTokens}.`);
console.log(`  maximum cost (every step a full 1h write${counted ? '' : ', estimate +30%'}): $${worst.toFixed(4)}; predicted: $${predicted.toFixed(4)}`);
if (failed.length) fail('layout checks failed; fix those before measuring live.');
if (!args.yes) {
  console.log('  Nothing sent. Add --yes to send.');
  process.exit(0);
}
if (worst > maxCostLimit) fail(`maximum cost $${worst.toFixed(4)} is over --max-cost $${maxCostLimit}; refusing to send.`);
if (steps.length > MAX_MESSAGES_REQUESTS) fail('too many steps');

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

// Observe the provider's own request and response: the body it sent (to
// confirm it is the one analysed) and the raw usage, whose 5m/1h write split
// the normalised usage folds away.
const realFetch = globalThis.fetch;
let observed: { body?: string; usage?: RawUsage } = {};
globalThis.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  if (String(input) === `${API}messages`) {
    observed.body = typeof init?.body === 'string' ? init.body : undefined;
    observed.usage = ((await res.clone().json().catch(() => ({}))) as { usage?: RawUsage }).usage;
  }
  return res;
};

const provider = new AnthropicProvider();
let actualCost = 0;
let mismatches = 0;
const n = (v: number) => v.toLocaleString('en-US');
for (const [i, step] of steps.entries()) {
  observed = {};
  try {
    await provider.complete({ ...step.options, apiKey });
  } catch (err) {
    fail(`step ${step.id} failed: ${(err as Error).message}`);
  }
  const u = observed.usage ?? {};
  const write = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? write;
  const actual = { read: u.cache_read_input_tokens ?? 0, write1h, write5m: u.cache_creation?.ephemeral_5m_input_tokens ?? write - write1h, uncached: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
  const e = expected[i];
  const sameBody = observed.body === JSON.stringify(step.body);
  const ok = {
    read: S.withinTolerance(e.read, actual.read),
    write: S.withinTolerance(e.write1h + e.write5m, write),
    uncached: S.withinTolerance(e.uncached, actual.uncached),
  };
  const cost = S.costOf(actual, price);
  actualCost += cost;
  if (!ok.read || !ok.write || !ok.uncached || !sameBody) mismatches++;
  const mark = (good: boolean) => (good ? 'ok ' : 'MISMATCH');
  console.log(`Step ${step.id} — ${step.title}${sameBody ? '' : '  [sent body differs from the analysed one!]'}`);
  console.log(`  cache_read_input_tokens      expected ${n(e.read).padStart(8)}  actual ${n(actual.read).padStart(8)}  ${mark(ok.read)}`);
  console.log(`  cache_creation_input_tokens  expected ${n(e.write1h + e.write5m).padStart(8)}  actual ${n(write).padStart(8)}  ${mark(ok.write)}  (1h ${n(actual.write1h)}, 5m ${n(actual.write5m)})`);
  console.log(`  input_tokens (uncached)      expected ${n(e.uncached).padStart(8)}  actual ${n(actual.uncached).padStart(8)}  ${mark(ok.uncached)}`);
  console.log(`  output_tokens ${actual.output}; cost $${cost.toFixed(4)}`);
}
console.log('');
console.log(`Total cost: $${actualCost.toFixed(4)} (predicted $${predicted.toFixed(4)}). ${mismatches ? `${mismatches} step(s) did not match: see docs/DIRECT-PROVIDERS.md, "Reading a mismatch".` : 'Every step matched.'}`);
process.exit(mismatches ? 1 : 0);

/**
 * The network-free half of `scripts/measure-prompt-cache.ts`: build the root
 * agent's native Anthropic request bodies for a short two-user scenario, find
 * their cache breakpoints, check which prefixes are byte-identical between
 * steps, and predict what the API should report as cache reads and writes.
 *
 * The requests come from the same assembly the cache-layout tests pin
 * (`src/core/agent/root-request-fixture.ts`): real role prompt, persona
 * insertion, delegation text, prompt builder, install-tier split, AgentWorker
 * tool ordering and deferral, and `AnthropicProvider`'s native body builder.
 *
 * The prediction models the API's documented behaviour: an entry is written
 * at each breakpoint whose prefix reaches the model's minimum cacheable
 * length; a request reads the longest entry whose prefix it repeats, found at
 * one of its breakpoints or up to 20 blocks before one; it writes what lies
 * between that read and its last breakpoint; the rest is uncached input.
 */
import { createHash } from 'node:crypto';
import type { ToolAdvertisement, ToolHandler } from '@/core/agent-base';
import {
  assembleRootPrompt,
  fixtureHandler,
  nativeRequestBody,
  rootSystemMessages,
  workerRequestTools,
} from '@/core/agent/root-request-fixture';
import type { AgentMessage } from '@/core/types';
import { insertPersonaBlock } from '@/core/personas/persona-hook';
import type { CompletionOptions } from '@/models/litellm-client';
import { buildToolDiscoveryHandlers } from '@/tools/tool-discovery';
import { buildCapabilitiesHandler } from '@/tools/self-report';
import { estimateTokens } from '@/utils/token-count';

// ── Scenario ────────────────────────────────────────────────────────────────

export type UserKey = 'A' | 'B';
const USER_ID: Record<UserKey, string> = { A: 'alice', B: 'bob' };

/** The direct MCP tool that appears in user A's session before step A3. */
export const LATE_MCP_TOOL = 'mcp__github__search_issues';

/** The MCP bridge's meta-tools in its order: the same for every user of the install. */
const MCP_META = ['mcp_list_resources', 'mcp_read_resource', 'mcp_get_prompt', 'mcp_read_result', 'mcp_list_tools', 'mcp_call_tool'];

export interface ScenarioStep {
  id: 'A1' | 'A2' | 'B1' | 'A3';
  user: UserKey;
  title: string;
  /** What the cache design promises for this step, in words. */
  promise: string;
  options: CompletionOptions;
  body: Record<string, unknown>;
}

export interface ScenarioOptions {
  model: string;
  /**
   * The install's built-in root tools, registered first. The script passes
   * the real root-role toolboxes; tests pass small fixtures.
   */
  builtins: ToolHandler[];
  /** Core (always-advertised) groups of the root role. */
  coreToolIds: string[];
  /** `max_tokens` sent (through `extraBody`, so 0 reaches the wire). Default 0. */
  maxTokens?: number;
}

/** The rendered shape of a persona block (resolver.ts `renderPromptBlock`). */
function personaBlock(user: UserKey): string {
  const [name, tone] = user === 'A' ? ['Ada', 'dry'] : ['Bix', 'warm'];
  return `--- PERSONA ---\nYou are ${name}, tone ${tone}.\n\nADDITIONAL FACTS THE USER HAS SET ABOUT YOU:\n- ${USER_ID[user]} likes tea\n\n--- END PERSONA ---\n\n`;
}

/**
 * One user's registered tools, in the root's registration order (see
 * `tool-cache-order.test.ts`): built-ins, the bridge's direct MCP tools,
 * its meta-tools, extension tools, connectors, the inline-UI tool, discovery,
 * delegation meta-tools, the self-report tool.
 */
export function scenarioTools(user: UserKey, builtins: ToolHandler[], withLateMcp: boolean): ToolHandler[] {
  const a = user === 'A';
  return [
    ...builtins,
    ...(a ? [fixtureHandler('mcp__crm__lookup', 'mcp', 'Look up a CRM contact')] : []),
    ...(a && withLateMcp ? [fixtureHandler(LATE_MCP_TOOL, 'mcp', 'Search GitHub issues')] : []),
    ...MCP_META.map((n) => fixtureHandler(n, 'mcp')),
    ...(a ? [fixtureHandler('ext_quotes__get', 'ext_quotes')] : [fixtureHandler('ext_tides__get', 'ext_tides')]),
    ...(a ? [fixtureHandler('gmail_search', 'connector')] : [fixtureHandler('slack_post', 'connector'), fixtureHandler('slack_read', 'connector')]),
    fixtureHandler('inline_ui_ask', 'inline-ui', 'Ask the user with an inline form'),
    ...buildToolDiscoveryHandlers(builtins),
    fixtureHandler('spawn_child', undefined, 'Delegate a task to a specialist child agent'),
    fixtureHandler('collect_children', undefined, 'Collect the results of spawned children'),
    buildCapabilitiesHandler({ advertised: [], registered: [], userId: USER_ID[user], model: 'scenario', role: 'general' } as Parameters<typeof buildCapabilitiesHandler>[0]),
  ];
}

const turnDate = (minute: number) => `\n\nCURRENT DATE & TIME: Mon, 09 Nov 2026 12:${String(minute).padStart(2, '0')}:00 GMT`;

/** The system messages and this turn's context for one user, as the root runner and agent manager hand them over. */
async function rootTurn(user: UserKey, minute: number): Promise<{ system: AgentMessage[]; turnContext: string }> {
  const prompt = await assembleRootPrompt({
    userId: USER_ID[user],
    workspace: `/w/${USER_ID[user]}`,
    turnContext: turnDate(minute),
    hook: async (input) => insertPersonaBlock(input.systemPrompt, personaBlock(user)),
  });
  const { messages, turnContext } = rootSystemMessages(prompt);
  return { system: messages, turnContext };
}

/** A user message as `AgentWorker.addUserMessage` builds it: the turn context first. */
const userTurn = (turnContext: string, text: string): AgentMessage => ({ role: 'user', content: [turnContext.trim(), text].filter(Boolean).join('\n\n'), timestamp: new Date(0) });
const assistantTurn = (text: string): AgentMessage => ({ role: 'assistant', content: text, timestamp: new Date(0) });

/** The four steps: A turn 1, A turn 2, B turn 1, A turn 3 after an MCP tool appeared. */
export async function buildScenario(options: ScenarioOptions): Promise<ScenarioStep[]> {
  const { model, builtins, coreToolIds, maxTokens = 0 } = options;
  const advertisement: ToolAdvertisement = { mode: 'lazy', coreToolIds: [...coreToolIds, 'self_report', 'inline-ui'], groupOrder: coreToolIds };
  const request = (user: UserKey, messages: AgentMessage[], lateMcp = false): { options: CompletionOptions; body: Record<string, unknown> } => {
    const tools = workerRequestTools(USER_ID[user], scenarioTools(user, builtins, lateMcp), advertisement, { provider: 'anthropic', modelId: model });
    const opts: CompletionOptions = {
      model,
      messages: messages as CompletionOptions['messages'],
      tools: tools.declarableTools,
      ...(tools.deferredTools ? { deferredTools: tools.deferredTools } : {}),
      sharedToolCount: tools.sharedToolCount,
      // An attended root turn: the hour on the stable prefix (`cacheTtlsFor`).
      cacheScope: 'root:cache-scenario',
      cachePacing: 'human',
      extraBody: { max_tokens: maxTokens },
    };
    return { options: opts, body: nativeRequestBody(opts) };
  };

  const a1 = await rootTurn('A', 0);
  const a2 = await rootTurn('A', 7);
  const a3 = await rootTurn('A', 14);
  const b1 = await rootTurn('B', 9);
  const aTurn1 = userTurn(a1.turnContext, 'What changed in the deploy script last week?');
  const aAnswer1 = assistantTurn('The deploy script now pins the Node version and retries the health check twice.');
  const aTurn2 = userTurn(a2.turnContext, 'Does the retry apply to the staging target too?');
  const aAnswer2 = assistantTurn('Yes: staging and production share the same health-check step.');
  const aTurn3 = userTurn(a3.turnContext, 'Find the GitHub issue that asked for the retry.');

  const a1Request = request('A', [...a1.system, aTurn1]);
  const toolSearch = Boolean(a1Request.options.deferredTools?.length);
  return [
    {
      id: 'A1', user: 'A', title: 'user A, turn 1',
      promise: 'cold start: writes tools + install tier + system (1h) and the turn (5m); reads nothing',
      ...a1Request,
    },
    {
      id: 'A2', user: 'A', title: 'user A, turn 2',
      promise: 'reads A1 through its history breakpoint (tools + system + turn 1); writes only answer 1 + turn 2',
      ...request('A', [...a2.system, aTurn1, aAnswer1, aTurn2]),
    },
    {
      id: 'B1', user: 'B', title: 'user B, turn 1',
      promise: toolSearch
        ? "reads the shared tools + install tier A1 wrote; writes B's own system tail and turn"
        : "no tool search: B's own tools precede the install tier, so it reads only A1's tools entry and writes the rest",
      ...request('B', [...b1.system, userTurn(b1.turnContext, 'Summarise my open tasks.')]),
    },
    {
      id: 'A3', user: 'A', title: `user A, turn 3 (MCP tool ${LATE_MCP_TOOL} appeared)`,
      promise: toolSearch
        ? 'with tool search the new direct MCP tool is deferred, so nothing in the prefix moves: reads A2 through its history breakpoint'
        : 'no tool search: the new tool loads after the tools breakpoint, so it reads only the tools entry and rewrites the rest (by design)',
      ...request('A', [...a3.system, aTurn1, aAnswer1, aTurn2, aAnswer2, aTurn3], true),
    },
  ];
}

// ── Body analysis ───────────────────────────────────────────────────────────

export type BreakpointKind = 'tools' | 'install' | 'system' | 'history';
export type Ttl = '5m' | '1h';

/** One block of the cached prompt prefix, in render order: tools, system, messages. */
export interface PrefixBlock {
  section: 'tools' | 'system' | 'messages';
  label: string;
  /** The block's bytes as the prefix renders them (no `cache_control`). */
  key: string;
  /** The text tokens are estimated from. */
  text: string;
  /** Where it sits in the body. */
  path: { index: number; block?: number };
  breakpoint?: { kind: BreakpointKind; ttl: Ttl };
}

export interface BodyAnalysis {
  blocks: PrefixBlock[];
  /** Indexes into `blocks` of the breakpoints, in order. */
  breakpoints: number[];
  declaredTools: number;
  loadedTools: number;
  deferredTools: string[];
  toolSearch: boolean;
  /** Prefix-hash after each block: equal hashes ⇔ equal prefixes. */
  hashes: string[];
  /** Request-level fields that are part of the cache key (model, tool_choice, thinking). */
  header: string;
}

type Json = Record<string, unknown>;
const ttlOf = (cc: unknown): Ttl => ((cc as { ttl?: string }).ttl === '1h' ? '1h' : '5m');
function withoutCacheControl(value: Json): Json {
  const { cache_control: _cc, ...rest } = value;
  return rest;
}

/** Split a native request body into its prefix blocks and breakpoints. */
export function analyzeBody(body: Json): BodyAnalysis {
  const blocks: PrefixBlock[] = [];
  const tools = (body.tools as Json[] | undefined) ?? [];
  const deferredTools: string[] = [];
  let toolSearch = false;
  tools.forEach((tool, index) => {
    if (tool.defer_loading === true) {
      deferredTools.push(String(tool.name));
      if (tool.cache_control) throw new Error(`deferred tool ${String(tool.name)} carries cache_control (a 400)`);
      return;
    }
    if (!('input_schema' in tool)) toolSearch = true;
    const key = JSON.stringify(withoutCacheControl(tool));
    blocks.push({
      section: 'tools', label: `tools[${index}] ${String(tool.name)}`, key, text: key, path: { index },
      ...(tool.cache_control ? { breakpoint: { kind: 'tools' as const, ttl: ttlOf(tool.cache_control) } } : {}),
    });
  });
  const system = body.system;
  const systemBlocks: Json[] = typeof system === 'string' ? [{ type: 'text', text: system }] : ((system as Json[] | undefined) ?? []);
  const lastCachedSystem = systemBlocks.map((b) => Boolean(b.cache_control)).lastIndexOf(true);
  systemBlocks.forEach((block, index) => {
    const kind: BreakpointKind = index === lastCachedSystem ? 'system' : 'install';
    blocks.push({
      section: 'system', label: `system[${index}]`, key: JSON.stringify({ system: withoutCacheControl(block) }), text: String(block.text ?? ''), path: { index },
      ...(block.cache_control ? { breakpoint: { kind, ttl: ttlOf(block.cache_control) } } : {}),
    });
  });
  const messages = (body.messages as Array<{ role: string; content: string | Json[] }> | undefined) ?? [];
  messages.forEach((message, index) => {
    const content: Json[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    content.forEach((block, b) => {
      blocks.push({
        section: 'messages', label: `messages[${index}].content[${b}] (${message.role})`,
        key: JSON.stringify({ role: message.role, start: b === 0, block: withoutCacheControl(block) }),
        text: typeof block.text === 'string' ? block.text : JSON.stringify(withoutCacheControl(block)),
        path: { index, block: b },
        ...(block.cache_control ? { breakpoint: { kind: 'history' as const, ttl: ttlOf(block.cache_control) } } : {}),
      });
    });
  });
  const hashes: string[] = [];
  let h = createHash('sha256').update(String(body.model)).digest('hex');
  for (const block of blocks) {
    h = createHash('sha256').update(h).update(block.key).digest('hex');
    hashes.push(h);
  }
  return {
    blocks,
    breakpoints: blocks.flatMap((b, i) => (b.breakpoint ? [i] : [])),
    declaredTools: tools.length,
    loadedTools: tools.length - deferredTools.length,
    deferredTools,
    toolSearch,
    hashes,
    header: JSON.stringify({ model: body.model, tool_choice: body.tool_choice, thinking: body.thinking, output_config: body.output_config }),
  };
}

/** Token estimate per block (`estimateTokens`, the repo's heuristic — not the API tokenizer). */
export function estimatedCumulative(analysis: BodyAnalysis): number[] {
  let sum = 0;
  return analysis.blocks.map((b) => (sum += estimateTokens(b.text)));
}

// ── Byte-identity checks ────────────────────────────────────────────────────

export interface IdentityCheck {
  name: string;
  expected: boolean;
  actual: boolean;
  ok: boolean;
  note?: string;
}

const bpOf = (a: BodyAnalysis, kind: BreakpointKind) => a.breakpoints.find((i) => a.blocks[i].breakpoint?.kind === kind);
/** Whether `a` and `b` render the same bytes through block `upTo` (inclusive). */
const sameThrough = (a: BodyAnalysis, b: BodyAnalysis, upTo: number | undefined) =>
  upTo !== undefined && a.header === b.header && a.hashes[upTo] !== undefined && a.hashes[upTo] === b.hashes[upTo];

/** The layout invariants of one request and the cross-step identities the design relies on. */
export function identityChecks(steps: ScenarioStep[], analyses: BodyAnalysis[]): IdentityCheck[] {
  const by = Object.fromEntries(steps.map((s, i) => [s.id, analyses[i]])) as Record<ScenarioStep['id'], BodyAnalysis>;
  const checks: IdentityCheck[] = [];
  const add = (name: string, expected: boolean, actual: boolean, note?: string) => checks.push({ name, expected, actual, ok: expected === actual, ...(note ? { note } : {}) });

  steps.forEach((step, i) => {
    const a = analyses[i];
    const ttls = a.breakpoints.map((j) => a.blocks[j].breakpoint!.ttl);
    add(`${step.id}: at most 4 breakpoints (has ${a.breakpoints.length})`, true, a.breakpoints.length <= 4);
    add(`${step.id}: 1h breakpoints all precede 5m ones`, true, !ttls.includes('5m') || ttls.lastIndexOf('1h') < ttls.indexOf('5m'));
    add(`${step.id}: breakpoints on tools, install, system end, history`, true,
      JSON.stringify(a.breakpoints.map((j) => a.blocks[j].breakpoint!.kind)) === JSON.stringify(['tools', 'install', 'system', 'history']));
  });

  const { A1, A2, B1, A3 } = by;
  add('A1 vs B1: same bytes through the tools breakpoint', true, sameThrough(A1, B1, bpOf(A1, 'tools')) && bpOf(A1, 'tools') === bpOf(B1, 'tools'));
  // Tools come before the system prompt: a per-user tool loaded after the
  // tools breakpoint makes the install entry per-user too. Tool search defers
  // those tools; without it the install entry is not shared, by design.
  add('A1 vs B1: same bytes through the install-tier breakpoint', A1.toolSearch, sameThrough(A1, B1, bpOf(A1, 'install')) && bpOf(A1, 'install') === bpOf(B1, 'install'),
    A1.toolSearch ? undefined : 'no tool search: the per-user tools after the tools breakpoint precede the install tier');
  add('A1 vs B1: system after the install tier differs (persona, workspace)', false, sameThrough(A1, B1, bpOf(A1, 'system')));
  add('A1 vs A2: same bytes through the system breakpoint', true, sameThrough(A1, A2, bpOf(A1, 'system')) && bpOf(A1, 'system') === bpOf(A2, 'system'));
  add("A1 vs A2: A1's whole prompt is a prefix of A2", true, sameThrough(A1, A2, A1.blocks.length - 1));
  // The late MCP tool: deferred under tool search (nothing moves), loaded
  // after the tools breakpoint otherwise (the install entry moves, by design).
  const lateDeferred = A3.deferredTools.includes(LATE_MCP_TOOL);
  add('A2 vs A3: same loaded tool bytes after the MCP tool appeared', lateDeferred, sameThrough(A2, A3, bpOf(A2, 'system')) && bpOf(A2, 'system') === bpOf(A3, 'system'),
    lateDeferred ? `${LATE_MCP_TOOL} is deferred (tool search)` : `${LATE_MCP_TOOL} is loaded after the tools breakpoint (no tool search): a new prefix from there, by design`);
  add('A2 vs A3: same bytes through the tools breakpoint', true, sameThrough(A2, A3, bpOf(A2, 'tools')));
  if (lateDeferred) add("A2 vs A3: A2's whole prompt is a prefix of A3", true, sameThrough(A2, A3, A2.blocks.length - 1));
  return checks;
}

// ── Expected cache usage ────────────────────────────────────────────────────

export interface CacheUsage {
  read: number;
  write5m: number;
  write1h: number;
  /** Input tokens neither read nor written. */
  uncached: number;
}

export interface Expectation extends CacheUsage {
  total: number;
  /** The block the read ends on, when there is one. */
  readThrough?: string;
}

/** The API's lookback: a breakpoint finds entries at most this many blocks before it. */
export const LOOKBACK_BLOCKS = 20;

/**
 * What each step should report, given cumulative token counts at each block
 * (`cumulative[step][block]`, estimated or counted) and the model's minimum
 * cacheable prefix. Steps run in order; each one's entries are visible to the
 * steps after it (they all run within the 5-minute TTL).
 */
export function expectCache(analyses: BodyAnalysis[], cumulative: number[][], minCacheable: number, totals?: number[]): Expectation[] {
  const entries = new Map<string, number>();
  return analyses.map((a, s) => {
    const cum = cumulative[s];
    const total = totals?.[s] ?? cum.at(-1) ?? 0;
    let read = 0;
    let readThrough: string | undefined;
    for (const bp of a.breakpoints) {
      for (let j = bp; j >= Math.max(0, bp - LOOKBACK_BLOCKS); j--) {
        const hit = entries.get(a.hashes[j]);
        if (hit !== undefined && hit > read) {
          read = hit;
          readThrough = a.blocks[j].label;
        }
      }
    }
    const written = (bp: number | undefined) => (bp !== undefined && cum[bp] >= minCacheable ? Math.max(0, cum[bp] - read) : 0);
    const last = a.breakpoints.at(-1);
    const last1h = [...a.breakpoints].reverse().find((i) => a.blocks[i].breakpoint!.ttl === '1h');
    const write = written(last);
    const write1h = Math.min(write, written(last1h));
    for (const bp of a.breakpoints) if (cum[bp] >= minCacheable) entries.set(a.hashes[bp], cum[bp]);
    return { total, read, write1h, write5m: write - write1h, uncached: Math.max(0, total - read - write), ...(readThrough ? { readThrough } : {}) };
  });
}

/** Within tolerance: counted prefixes carry a placeholder turn and the API's own framing. */
export function withinTolerance(expected: number, actual: number): boolean {
  return Math.abs(expected - actual) <= Math.max(64, expected * 0.03);
}

// ── Models: cache minimum and pricing ───────────────────────────────────────

/** Bare model id: no provider path, no date or context suffix. */
const bare = (model: string) => model.toLowerCase().replace(/^.*\//, '').replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');

/** Minimum cacheable prefix in tokens (claude-api skill, shared/prompt-caching.md). */
export function minCacheableTokens(model: string): number {
  const id = bare(model);
  if (/^claude-(opus-4-[56]|haiku-4-5)/.test(id)) return 4096;
  if (/^claude-(opus-4-7|mythos-preview|3-5-haiku|haiku-3-5)/.test(id)) return 2048;
  if (/^claude-(opus-4-8|sonnet-5$|sonnet-5-0|sonnet-4|opus-4)/.test(id)) return 1024;
  return 512;
}

/** USD per million tokens. */
export interface Pricing { input: number; output: number; cacheRead: number; write5m: number; write1h: number }

const priced = (input: number, output: number, cacheRead: number): Pricing => ({ input, output, cacheRead, write5m: input * 1.25, write1h: input * 2 });

/**
 * Prices from the claude-api skill (shared/models.md): writes are 1.25x
 * input for 5 minutes and 2x for an hour (shared/prompt-caching.md). Haiku
 * 5.5's cache-read price is not listed there; 0.1x input is assumed.
 */
export const PRICING: Record<string, Pricing> = {
  'claude-opus-5-5': priced(4, 20, 0.2),
  'claude-sonnet-5-5': priced(2, 10, 0.1),
  'claude-haiku-5-5': priced(0.1, 0.5, 0.01),
  'claude-opus-5': priced(5, 25, 0.5),
  'claude-fable-5-2': priced(8, 40, 0.2),
  'claude-mythos-5-2': priced(8, 40, 0.2),
  'claude-fable-5-1': priced(10, 50, 0.25),
  'claude-mythos-5-1': priced(10, 50, 0.25),
};

export function pricingFor(model: string): Pricing | undefined {
  return PRICING[bare(model)];
}

export function costOf(usage: CacheUsage & { output?: number }, price: Pricing): number {
  return (usage.uncached * price.input + usage.read * price.cacheRead + usage.write5m * price.write5m + usage.write1h * price.write1h + (usage.output ?? 0) * price.output) / 1e6;
}

/** The most a run can cost: every step writes its whole prompt at the hour rate and spends its whole output budget. */
export function maxCost(totals: number[], maxOutput: number, price: Pricing): number {
  return totals.reduce((sum, total) => sum + (total * price.write1h + maxOutput * price.output) / 1e6, 0);
}

// ── Count-tokens request for a prefix ───────────────────────────────────────

/**
 * A `count_tokens` body for the prefix through `blocks[upTo]`: the request cut
 * after that block, with a one-character user turn when the cut leaves none
 * (the endpoint needs a message). The placeholder and the API's framing are
 * why counted prefixes are compared within a tolerance.
 */
export function prefixCountBody(body: Json, analysis: BodyAnalysis, upTo: number): Json {
  const block = analysis.blocks[upTo];
  const placeholder = [{ role: 'user', content: '.' }];
  const base: Json = { model: body.model };
  for (const key of ['tool_choice', 'thinking', 'output_config']) if (body[key] !== undefined) base[key] = body[key];
  const tools = (body.tools as Json[] | undefined) ?? [];
  if (block.section === 'tools') {
    // tool_choice is meaningless without the rest; keep it only while tools remain.
    return { ...base, tools: tools.slice(0, block.path.index + 1), messages: placeholder };
  }
  const withTools = tools.length ? { ...base, tools } : base;
  if (block.section === 'system') {
    const system = typeof body.system === 'string' ? body.system : (body.system as Json[]).slice(0, block.path.index + 1);
    return { ...withTools, system, messages: placeholder };
  }
  const messages = body.messages as Array<{ role: string; content: string | Json[] }>;
  const cut = messages.slice(0, block.path.index);
  const last = messages[block.path.index];
  cut.push({ role: last.role, content: typeof last.content === 'string' ? last.content : last.content.slice(0, (block.path.block ?? 0) + 1) });
  if (last.role !== 'user') cut.push(placeholder[0]);
  return { ...withTools, ...(body.system !== undefined ? { system: body.system } : {}), messages: cut };
}

// ── Report ──────────────────────────────────────────────────────────────────

const n = (v: number) => v.toLocaleString('en-US');

export function formatStep(step: ScenarioStep, a: BodyAnalysis, cum: number[], expected: Expectation, unit: string): string[] {
  const lines = [`Step ${step.id} — ${step.title}`, `  promise: ${step.promise}`];
  lines.push(`  tools: ${a.declaredTools} declared, ${a.loadedTools} loaded${a.toolSearch ? ` (tool search on, ${a.deferredTools.length} deferred)` : ' (no tool search)'}`);
  lines.push(`  breakpoints (${a.breakpoints.length}/4):`);
  for (const i of a.breakpoints) {
    const b = a.blocks[i];
    lines.push(`    ${b.breakpoint!.kind.padEnd(8)} ${b.breakpoint!.ttl}  ${b.label.padEnd(42)} through ${n(cum[i])} ${unit}`);
  }
  const at = (kind: BreakpointKind) => {
    const i = a.breakpoints.find((j) => a.blocks[j].breakpoint?.kind === kind);
    return i === undefined ? undefined : cum[i];
  };
  const lastTool = a.blocks.map((b) => b.section).lastIndexOf('tools');
  const toolsBp = at('tools') ?? 0;
  const toolsEnd = lastTool >= 0 ? cum[lastTool] : 0;
  const install = at('install') ?? toolsEnd;
  const system = at('system') ?? install;
  const history = at('history') ?? system;
  const total = expected.total;
  lines.push(`  segments, ${unit}: tools to breakpoint ${n(toolsBp)} | tools after it ${n(toolsEnd - toolsBp)} | install tier ${n(install - toolsEnd)} | system tail ${n(system - install)} | history ${n(history - system)} | after last breakpoint ${n(Math.max(0, total - history))} | total ${n(total)}`);
  lines.push(`  expected: read ${n(expected.read)}${expected.readThrough ? ` (through ${expected.readThrough})` : ''}, write ${n(expected.write1h + expected.write5m)} (1h ${n(expected.write1h)}, 5m ${n(expected.write5m)}), uncached ${n(expected.uncached)}`);
  return lines;
}

export function formatChecks(checks: IdentityCheck[]): string[] {
  return [
    'Byte-identity and layout checks:',
    ...checks.map((c) => `  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}${c.expected ? '' : ' [expected: differs]'}${c.note ? ` — ${c.note}` : ''}`),
  ];
}

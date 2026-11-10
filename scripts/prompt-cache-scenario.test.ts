/**
 * The dry-run half of `measure-prompt-cache.ts`: the scenario's request
 * bodies, their breakpoints, the byte-identities between steps and the
 * predicted cache reads and writes. No network.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as config from '@/config';
import { fixtureHandler } from '@/core/agent/root-request-fixture';
import {
  analyzeBody,
  type BodyAnalysis,
  buildScenario,
  costOf,
  estimatedCumulative,
  expectCache,
  formatStep,
  identityChecks,
  LATE_MCP_TOOL,
  LOOKBACK_BLOCKS,
  maxCost,
  minCacheableTokens,
  prefixCountBody,
  pricingFor,
  withinTolerance,
} from './prompt-cache-scenario';

const builtins = ['filesystem', 'shell', 'skill-distill', 'websearch', 'notes'].map((id) => fixtureHandler(`${id}__op`, id, `${id} operation. ${'Detail. '.repeat(40)}`));
const coreToolIds = ['filesystem', 'shell', 'skill-distill', 'websearch', 'notes'];

function toolSearch(on: boolean) {
  const real = config.getConfig();
  vi.spyOn(config, 'getConfig').mockReturnValue({ ...real, agent: { ...real.agent, nativeToolSearch: on } });
}

async function scenario(on: boolean) {
  toolSearch(on);
  const steps = await buildScenario({ model: 'claude-opus-5-5', builtins, coreToolIds });
  const analyses = steps.map((s) => analyzeBody(s.body));
  return { steps, analyses, cumulative: analyses.map(estimatedCumulative) };
}

const bp = (a: BodyAnalysis, kind: string) => a.breakpoints.find((i) => a.blocks[i].breakpoint?.kind === kind)!;

afterEach(() => vi.restoreAllMocks());

describe('scenario requests (tool search on)', () => {
  test('builds four native bodies without touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { steps } = await scenario(true);
    expect(steps.map((s) => s.id)).toEqual(['A1', 'A2', 'B1', 'A3']);
    expect(fetchSpy).not.toHaveBeenCalled();
    // max_tokens 0 (prefill only) reaches the body through extraBody.
    expect(steps.every((s) => s.body.max_tokens === 0)).toBe(true);
  });

  test('four breakpoints in the designed places, 1h before 5m; the late MCP tool is deferred', async () => {
    const { analyses } = await scenario(true);
    for (const a of analyses) {
      expect(a.toolSearch).toBe(true);
      expect(a.breakpoints.map((i) => [a.blocks[i].breakpoint!.kind, a.blocks[i].breakpoint!.ttl])).toEqual([
        ['tools', '1h'], ['install', '1h'], ['system', '1h'], ['history', '5m'],
      ]);
      expect(a.blocks[bp(a, 'tools')].label).toContain('capabilities');
    }
    expect(analyses[3].deferredTools).toContain(LATE_MCP_TOOL);
    expect(analyses[0].deferredTools).not.toContain(LATE_MCP_TOOL);
  });

  test('every byte-identity check holds', async () => {
    const { steps, analyses } = await scenario(true);
    const checks = identityChecks(steps, analyses);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.find((c) => c.name.startsWith('A1 vs B1: same bytes through the install'))?.actual).toBe(true);
  });

  test('predicted usage: cold write, history read, cross-user install read, no break on the MCP tool', async () => {
    const { analyses, cumulative } = await scenario(true);
    const [a1, a2, b1, a3] = expectCache(analyses, cumulative, 512);
    const total = (s: number) => cumulative[s].at(-1)!;
    expect(a1).toMatchObject({ read: 0, uncached: 0 });
    expect(a1.write1h + a1.write5m).toBe(total(0));
    expect(a1.write1h).toBe(cumulative[0][bp(analyses[0], 'system')]);
    expect(a2.read).toBe(total(0));
    expect(a2.write1h).toBe(0);
    expect(b1.read).toBe(cumulative[0][bp(analyses[0], 'install')]);
    expect(b1.readThrough).toBe('system[0]');
    expect(a3.read).toBe(total(1));
  });
});

describe('scenario requests (tool search off)', () => {
  test('per-user tools precede the install tier: user B and the late MCP tool read only the tools entry', async () => {
    const { steps, analyses, cumulative } = await scenario(false);
    expect(analyses[0].toolSearch).toBe(false);
    expect(analyses[3].deferredTools).toEqual([]);
    expect(identityChecks(steps, analyses).filter((c) => !c.ok)).toEqual([]);
    const [, a2, b1, a3] = expectCache(analyses, cumulative, 512);
    const toolsEntry = cumulative[0][bp(analyses[0], 'tools')];
    expect(a2.read).toBe(cumulative[0].at(-1));
    expect(b1.read).toBe(toolsEntry);
    expect(a3.read).toBe(toolsEntry);
  });
});

describe('expectCache', () => {
  test('a prefix below the model minimum is neither written nor read', async () => {
    const { analyses, cumulative } = await scenario(true);
    const out = expectCache(analyses, cumulative, 10_000_000);
    for (const [s, e] of out.entries()) expect(e).toMatchObject({ read: 0, write1h: 0, write5m: 0, uncached: cumulative[s].at(-1) });
  });

  test(`an entry more than ${LOOKBACK_BLOCKS} blocks before every breakpoint is not found`, () => {
    const block = (i: number, breakpoint?: boolean) => ({
      section: 'messages' as const, label: `b${i}`, key: `k${i}`, text: 'x', path: { index: i },
      ...(breakpoint ? { breakpoint: { kind: 'history' as const, ttl: '5m' as const } } : {}),
    });
    const analysis = (len: number, at: number): BodyAnalysis => ({
      blocks: Array.from({ length: len }, (_, i) => block(i, i === at)), breakpoints: [at],
      declaredTools: 0, loadedTools: 0, deferredTools: [], toolSearch: false, hashes: Array.from({ length: len }, (_, i) => `h${i}`), header: '',
    });
    const cum = (len: number) => Array.from({ length: len }, (_, i) => (i + 1) * 1000);
    const near = expectCache([analysis(3, 2), analysis(3 + LOOKBACK_BLOCKS, 2 + LOOKBACK_BLOCKS)], [cum(3), cum(3 + LOOKBACK_BLOCKS)], 512);
    expect(near[1].read).toBe(3000);
    const far = expectCache([analysis(3, 2), analysis(4 + LOOKBACK_BLOCKS, 3 + LOOKBACK_BLOCKS)], [cum(3), cum(4 + LOOKBACK_BLOCKS)], 512);
    expect(far[1].read).toBe(0);
  });

  test('tolerance: 64 tokens or 3%', () => {
    expect(withinTolerance(1000, 1060)).toBe(true);
    expect(withinTolerance(1000, 1070)).toBe(false);
    expect(withinTolerance(100_000, 102_900)).toBe(true);
  });
});

describe('analyzeBody', () => {
  test('a deferred tool carrying cache_control is reported (the API rejects it)', () => {
    const body = { model: 'm', tools: [{ name: 't', input_schema: {}, defer_loading: true, cache_control: { type: 'ephemeral' } }], messages: [] };
    expect(() => analyzeBody(body)).toThrow(/deferred tool t/);
  });

  test('cache_control does not change a block\'s key; a different tool_choice changes the header', () => {
    const base = { model: 'm', tools: [{ name: 't', input_schema: {} }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };
    const marked = { ...base, tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral', ttl: '1h' } }] };
    expect(analyzeBody(base).hashes).toEqual(analyzeBody(marked).hashes);
    expect(analyzeBody(base).header).not.toBe(analyzeBody({ ...base, tool_choice: { type: 'none' } }).header);
  });
});

describe('prefixCountBody', () => {
  test('cuts the request at a breakpoint, adding a placeholder turn where none is left', async () => {
    const { steps, analyses } = await scenario(true);
    const body = steps[1].body;
    const a = analyses[1];
    const atTools = prefixCountBody(body, a, bp(a, 'tools'));
    expect(atTools.system).toBeUndefined();
    expect(atTools.messages).toEqual([{ role: 'user', content: '.' }]);
    expect((atTools.tools as Array<{ name: string }>).at(-1)?.name).toBe('capabilities');
    const atInstall = prefixCountBody(body, a, bp(a, 'install'));
    expect(atInstall.system).toEqual([(body.system as unknown[])[0]]);
    const atHistory = prefixCountBody(body, a, bp(a, 'history'));
    expect(atHistory.messages).toEqual(body.messages);
    expect(atHistory.max_tokens).toBeUndefined();
  });
});

describe('models', () => {
  test('minimum cacheable prefix per the skill table', () => {
    expect(minCacheableTokens('claude-opus-5-5')).toBe(512);
    expect(minCacheableTokens('anthropic/claude-sonnet-4-6')).toBe(1024);
    expect(minCacheableTokens('claude-opus-4-7')).toBe(2048);
    expect(minCacheableTokens('claude-haiku-4-5-20251001')).toBe(4096);
  });

  test('pricing and cost', () => {
    const p = pricingFor('claude-opus-5-5')!;
    expect(p).toEqual({ input: 4, output: 20, cacheRead: 0.2, write5m: 5, write1h: 8 });
    expect(pricingFor('claude-unknown-9')).toBeUndefined();
    expect(costOf({ read: 1e6, write5m: 1e6, write1h: 1e6, uncached: 1e6, output: 1e6 }, p)).toBeCloseTo(4 + 0.2 + 5 + 8 + 20);
    expect(maxCost([1e6, 1e6], 0, p)).toBeCloseTo(16);
  });
});

describe('report', () => {
  test('labels the token unit it was given', async () => {
    const { steps, analyses, cumulative } = await scenario(true);
    const [e] = expectCache(analyses, cumulative, 512);
    const text = formatStep(steps[0], analyses[0], cumulative[0], e, 'tok est.').join('\n');
    expect(text).toContain('tok est.');
    expect(text).toMatch(/tools\s+1h\s+tools\[\d+\] capabilities/);
  });
});

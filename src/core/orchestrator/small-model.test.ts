/**
 * Worker-side small-model adaptation — the mirror of the orchestrator mode
 * selector for workers. Keys off model SIZE (house rule #2), trims tools when
 * the bound model is in the router tier, and never degrades a model whose size
 * can't be determined.
 */
import { describe, expect, test } from 'bun:test';
import { applyToolCap, capToolsForSmallModel, isSmallModel } from './small-model';

const ROUTER_MAX = 10_000_000_000;

describe('isSmallModel', () => {
  test.each([
    ['llama3.1:8b-instruct-q4_K_M', true],
    ['qwen2.5:7b', true],
    ['llama3.2:1b', true],
    ['qwen2.5:14b', false],
    ['qwen2.5:32b', false],
    ['llama3.3:70b', false],
  ])('%s → small=%s by tag', (modelId, expected) => {
    expect(isSmallModel({ modelId }, ROUTER_MAX)).toBe(expected);
  });

  test('MoE aggregate is not mistaken for a tiny model', () => {
    // 8 × 7B = 56B — well above the router threshold.
    expect(isSmallModel({ modelId: 'mixtral:8x7b' }, ROUTER_MAX)).toBe(false);
  });

  test('prefers explicit metadata.paramCount over the tag', () => {
    expect(isSmallModel({ modelId: 'weird-name', metadata: { paramCount: 7_000_000_000 } }, ROUTER_MAX)).toBe(true);
    expect(isSmallModel({ modelId: 'weird-name', metadata: { paramCount: 30_000_000_000 } }, ROUTER_MAX)).toBe(false);
  });

  test('unknown size is NOT treated as small (no silent degradation of cloud models)', () => {
    expect(isSmallModel({ modelId: 'gpt-4o' }, ROUTER_MAX)).toBe(false);
    expect(isSmallModel({ modelId: 'claude-3-opus' }, ROUTER_MAX)).toBe(false);
  });

  test('respects a custom threshold', () => {
    // Raise the bar to 20B → a 14B model now counts as small.
    expect(isSmallModel({ modelId: 'qwen2.5:14b' }, 20_000_000_000)).toBe(true);
  });
});

describe('capToolsForSmallModel', () => {
  // Each entry is its own group (no toolId) — keeps the first N.
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tool${i}` }));

  test('keeps the first N groups in order and reports the dropped tail', () => {
    const { tools, dropped } = capToolsForSmallModel(mk(14), 7);
    expect(tools.map((t) => t.name)).toEqual(['tool0', 'tool1', 'tool2', 'tool3', 'tool4', 'tool5', 'tool6']);
    expect(dropped).toEqual(['tool7', 'tool8', 'tool9', 'tool10', 'tool11', 'tool12', 'tool13']);
  });

  test('caps by tool GROUP (toolId), not handler count — keeps whole tools', () => {
    // Mirrors a real role: filesystem expands to many handlers, then shell, git.
    const handlers = [
      { name: 'filesystem__read_file', toolId: 'filesystem' },
      { name: 'filesystem__write_file', toolId: 'filesystem' },
      { name: 'filesystem__list_directory', toolId: 'filesystem' },
      { name: 'shell__run', toolId: 'shell' },
      { name: 'git__status', toolId: 'git' },
      { name: 'git__commit', toolId: 'git' },
    ];
    // Cap to 2 groups → ALL filesystem + ALL shell handlers kept, git dropped.
    const { tools, dropped } = capToolsForSmallModel(handlers, 2);
    expect(tools.map((t) => t.name)).toEqual([
      'filesystem__read_file',
      'filesystem__write_file',
      'filesystem__list_directory',
      'shell__run',
    ]);
    expect(dropped).toEqual(['git__status', 'git__commit']);
    // No tool group is partially included.
    const keptGroups = new Set(tools.map((t) => t.toolId));
    const droppedGroups = new Set(handlers.filter((h) => dropped.includes(h.name)).map((h) => h.toolId));
    for (const g of droppedGroups) expect(keptGroups.has(g)).toBe(false);
  });

  test('no-op when group count is within the cap', () => {
    const handlers = [
      { name: 'filesystem__read', toolId: 'filesystem' },
      { name: 'filesystem__write', toolId: 'filesystem' },
      { name: 'shell__run', toolId: 'shell' },
    ];
    const { dropped } = capToolsForSmallModel(handlers, 7);
    expect(dropped).toEqual([]);
  });

  test('a non-positive cap is a no-op (never strips every tool)', () => {
    const { tools, dropped } = capToolsForSmallModel(mk(5), 0);
    expect(tools.length).toBe(5);
    expect(dropped).toEqual([]);
  });
});

describe('applyToolCap', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tool${i}` }));

  test('returns the capped list', () => {
    const kept = applyToolCap(mk(10), 4, { role: 'general', modelId: 'qwen2.5:7b' });
    expect(kept.map((t) => t.name)).toEqual(['tool0', 'tool1', 'tool2', 'tool3']);
  });

  test('returns the list unchanged when within the cap', () => {
    const three = mk(3);
    expect(applyToolCap(three, 7, { role: 'coding', modelId: 'qwen2.5:7b' })).toBe(three);
  });
});

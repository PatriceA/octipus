import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { _resetToolboxRegistryForTests, getToolboxRegistry } from './registry';
import type { ToolboxTool } from './types';
import { validatePipeline } from './validator';

function registerCollector(overrides: Partial<ToolboxTool> = {}): void {
  const r = getToolboxRegistry();
  r.register({
    id: 'art_collect_demo',
    family: 'collect',
    description: 'demo',
    keywords: [],
    defaultPermission: 'ALLOW',
    params: {
      url: { type: 'string', required: true, description: 'u' },
      method: { type: 'string', enum: ['GET', 'POST'], description: 'm' },
    },
    returns: 'x',
    examples: [],
    tips: [],
    async execute() { return 'ok'; },
    ...overrides,
  } as ToolboxTool);
}

describe('validatePipeline', () => {
  beforeEach(() => { _resetToolboxRegistryForTests(); });
  afterEach(() => { _resetToolboxRegistryForTests(); });

  test('passes a well-formed pipeline', () => {
    registerCollector();
    const result = validatePipeline({
      sources: [
        { name: 'feed', toolId: 'art_collect_demo', params: { url: 'https://x' }, refreshSeconds: 60 },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('requires at least one source', () => {
    const result = validatePipeline({ sources: [] });
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('sources');
  });

  test('flags missing tool id and unknown tool id', () => {
    registerCollector();
    const r1 = validatePipeline({
      sources: [{ name: 'a', toolId: '', params: {} } as never],
    });
    expect(r1.errors.some((e) => e.path === 'sources[0].toolId')).toBe(true);

    const r2 = validatePipeline({
      sources: [{ name: 'a', toolId: 'does_not_exist', params: { url: 'x' } }],
    });
    expect(r2.ok).toBe(false);
    expect(r2.errors[0].message).toContain('unknown toolbox tool');
  });

  test('rejects non-collect families when used as a source', () => {
    getToolboxRegistry().register({
      id: 'art_widget_demo',
      family: 'widget',
      description: 'd',
      keywords: [],
      defaultPermission: 'ALLOW',
      params: {},
      returns: 'x',
      examples: [],
      tips: [],
      async execute() { return 'ok'; },
    } as ToolboxTool);

    const result = validatePipeline({
      sources: [{ name: 'a', toolId: 'art_widget_demo', params: {} }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain('"widget"');
  });

  test('catches duplicate source names', () => {
    registerCollector();
    const result = validatePipeline({
      sources: [
        { name: 'a', toolId: 'art_collect_demo', params: { url: 'x' } },
        { name: 'a', toolId: 'art_collect_demo', params: { url: 'y' } },
      ],
    });
    expect(result.errors.some((e) => e.message.includes('duplicate'))).toBe(true);
  });

  test('catches missing required params and type mismatches', () => {
    registerCollector();
    const result = validatePipeline({
      sources: [{ name: 'a', toolId: 'art_collect_demo', params: { url: 123 } }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes('expected string'))).toBe(true);
  });

  test('warns about unknown params but does not fail', () => {
    registerCollector();
    const result = validatePipeline({
      sources: [
        {
          name: 'a',
          toolId: 'art_collect_demo',
          params: { url: 'x', extra: 'ignored' },
        },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.message.includes('unknown parameter'))).toBe(true);
  });

  test('enforces enum values', () => {
    registerCollector();
    const result = validatePipeline({
      sources: [
        { name: 'a', toolId: 'art_collect_demo', params: { url: 'x', method: 'DELETE' } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes('one of'))).toBe(true);
  });

  test('rejects invalid source name identifiers', () => {
    registerCollector();
    const result = validatePipeline({
      sources: [{ name: '1bad-name', toolId: 'art_collect_demo', params: { url: 'x' } }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes('valid identifier'))).toBe(true);
  });

  test('enforces minimum refreshSeconds', () => {
    registerCollector();
    const result = validatePipeline({
      sources: [
        { name: 'a', toolId: 'art_collect_demo', params: { url: 'x' }, refreshSeconds: 5 },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path.endsWith('refreshSeconds'))).toBe(true);
  });
});

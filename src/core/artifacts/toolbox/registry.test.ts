import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { _resetToolboxRegistryForTests, getToolboxRegistry } from './registry';
import type { ToolboxTool } from './types';

function mkTool(overrides: Partial<ToolboxTool> = {}): ToolboxTool {
  return {
    id: 'art_collect_demo',
    family: 'collect',
    description: 'Demo collector',
    keywords: ['demo'],
    defaultPermission: 'ALLOW',
    params: {},
    returns: 'demo',
    examples: [],
    tips: [],
    async execute() { return 'ok'; },
    ...overrides,
  } as ToolboxTool;
}

describe('ToolboxRegistry', () => {
  beforeEach(() => { _resetToolboxRegistryForTests(); });
  afterEach(() => { _resetToolboxRegistryForTests(); });

  test('register + get round-trip', () => {
    const r = getToolboxRegistry();
    const tool = mkTool();
    r.register(tool);
    expect(r.has('art_collect_demo')).toBe(true);
    expect(r.get('art_collect_demo')).toBe(tool);
  });

  test('rejects duplicate ids (loud failure)', () => {
    const r = getToolboxRegistry();
    r.register(mkTool());
    expect(() => r.register(mkTool())).toThrow(/duplicate/);
  });

  test('rejects id that does not match family prefix', () => {
    const r = getToolboxRegistry();
    expect(() => r.register(mkTool({ id: 'wrong_prefix_demo' }))).toThrow(/prefix/);
  });

  test('list filters by family and sorts deterministically', () => {
    const r = getToolboxRegistry();
    r.register(mkTool({ id: 'art_widget_z', family: 'widget', description: 'z' }));
    r.register(mkTool({ id: 'art_collect_a', description: 'a' }));
    r.register(mkTool({ id: 'art_collect_b', description: 'b' }));

    const all = r.list();
    expect(all.map((e) => e.id)).toEqual(['art_collect_a', 'art_collect_b', 'art_widget_z']);

    const widgets = r.list({ family: 'widget' });
    expect(widgets).toHaveLength(1);
    expect(widgets[0].id).toBe('art_widget_z');
  });

  test('search ranks id matches above prose matches', () => {
    const r = getToolboxRegistry();
    r.register(mkTool({
      id: 'art_collect_http_json',
      description: 'Fetch JSON',
      keywords: ['http', 'json'],
    }));
    r.register(mkTool({
      id: 'art_collect_rss',
      description: 'Read JSON Feed format',
      keywords: ['rss', 'atom'],
    }));

    const results = r.search('json');
    expect(results[0].id).toBe('art_collect_http_json');
    expect(results).toHaveLength(2);
  });

  test('search returns empty on no match', () => {
    const r = getToolboxRegistry();
    r.register(mkTool());
    expect(r.search('nothing-here-at-all')).toEqual([]);
  });

  test('describe returns full manifest and null for unknown', () => {
    const r = getToolboxRegistry();
    r.register(mkTool({
      params: { url: { type: 'string', description: 'u', required: true } },
      examples: [{ summary: 'ex', params: { url: 'x' } }],
      tips: ['t'],
    }));
    const d = r.describe('art_collect_demo');
    expect(d?.params.url.required).toBe(true);
    expect(d?.examples).toHaveLength(1);
    expect(d?.tips).toEqual(['t']);
    expect(r.describe('missing')).toBeNull();
  });
});

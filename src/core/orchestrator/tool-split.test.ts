/**
 * Lazy tool discovery split — partitions a role's flat handler list into the
 * advertised "core" set and the discoverable "long tail". See tool-split.ts.
 */
import { describe, expect, test } from 'bun:test';
import type { ToolHandler } from '@/core/agent-base';
import { isLongTailHandler, splitRoleTools } from './tool-split';

const handler = (name: string, toolId?: string): ToolHandler => ({
  name,
  description: `desc ${name}`,
  parameters: { type: 'object', properties: {} },
  toolId,
  execute: async () => null,
});

const HANDLERS: ToolHandler[] = [
  handler('web_search', 'websearch'),
  handler('kb_search', 'knowledge'),
  handler('read_file', 'filesystem'),
  handler('write_file', 'filesystem'),
  handler('save_artifact', 'artifacts'),
  handler('mcp_list_tools', 'mcp'),
  handler('spawn_child'), // no toolId — injected meta-tool
];

describe('splitRoleTools', () => {
  test('undefined coreToolIds → everything is core, long tail empty', () => {
    const { core, longTail } = splitRoleTools(HANDLERS, undefined);
    expect(core).toHaveLength(HANDLERS.length);
    expect(longTail).toHaveLength(0);
  });

  test('does not mutate the input array', () => {
    const before = [...HANDLERS];
    splitRoleTools(HANDLERS, ['websearch']);
    expect(HANDLERS).toEqual(before);
  });

  test('partitions by toolId against the core set', () => {
    const { core, longTail } = splitRoleTools(HANDLERS, ['websearch', 'knowledge']);
    const coreNames = core.map((h) => h.name);
    const tailNames = longTail.map((h) => h.name);

    expect(coreNames).toContain('web_search');
    expect(coreNames).toContain('kb_search');
    // long tail
    expect(tailNames).toEqual(expect.arrayContaining(['read_file', 'write_file', 'save_artifact']));
    // every filesystem handler (shared toolId) lands in the tail together
    expect(tailNames.filter((n) => n === 'read_file' || n === 'write_file')).toHaveLength(2);
  });

  test('mcp handlers always land in core (own discovery surface)', () => {
    const { core, longTail } = splitRoleTools(HANDLERS, ['websearch']);
    expect(core.map((h) => h.name)).toContain('mcp_list_tools');
    expect(longTail.map((h) => h.name)).not.toContain('mcp_list_tools');
  });

  test('ungrouped handlers (no toolId) stay core', () => {
    const { core } = splitRoleTools(HANDLERS, ['websearch']);
    expect(core.map((h) => h.name)).toContain('spawn_child');
  });
});

describe('lazy advertisement shape (mirrors agent-worker :1231 filter)', () => {
  // The worker registers core + longTail + discovery meta-tools, then advertises
  // everything that is NOT long tail. This asserts that composed result.
  test('advertises core + mcp + discovery, hides long tail (still registered)', async () => {
    const { buildToolDiscoveryHandlers } = await import('@/tools/tool-discovery');
    const coreIds = ['websearch', 'knowledge'];
    const { longTail } = splitRoleTools(HANDLERS, coreIds);
    const registered = [...HANDLERS, ...buildToolDiscoveryHandlers(longTail)];

    const advertised = registered
      .filter((h) => !isLongTailHandler(h, coreIds))
      .map((h) => h.name);

    expect(advertised).toEqual(
      expect.arrayContaining(['web_search', 'kb_search', 'mcp_list_tools', 'spawn_child', 'list_tools', 'describe_tool']),
    );
    expect(advertised).not.toContain('read_file');
    expect(advertised).not.toContain('save_artifact');
    // long-tail handlers remain in the registered set (callable by name)
    expect(registered.map((h) => h.name)).toContain('read_file');
  });
});

describe('isLongTailHandler', () => {
  test('true only for a defined, non-mcp, non-core toolId', () => {
    expect(isLongTailHandler(handler('x', 'filesystem'), ['websearch'])).toBe(true);
    expect(isLongTailHandler(handler('x', 'websearch'), ['websearch'])).toBe(false);
    expect(isLongTailHandler(handler('x', 'mcp'), ['websearch'])).toBe(false);
    expect(isLongTailHandler(handler('x', 'tool_discovery'), ['websearch'])).toBe(false);
    expect(isLongTailHandler(handler('x'), ['websearch'])).toBe(false);
  });
});

/**
 * Built-in tool discovery meta-tools — list_tools omits schemas, describe_tool
 * returns the exact schema, unknown names fail loud. See tool-discovery.ts.
 */
import { describe, expect, test } from 'bun:test';
import type { AgentContext } from '@/core/types';
import type { ToolHandler } from '@/core/agent-base';
import { buildToolDiscoveryHandlers } from './tool-discovery';

const ctx = {} as AgentContext;

const fileSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const longTail: ToolHandler[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: fileSchema,
    toolId: 'filesystem',
    execute: async () => null,
  },
  {
    name: 'save_artifact',
    description: 'Save an artifact',
    parameters: { type: 'object', properties: {} },
    toolId: 'artifacts',
    execute: async () => null,
  },
];

describe('buildToolDiscoveryHandlers', () => {
  test('empty long tail → no meta-tools advertised', () => {
    expect(buildToolDiscoveryHandlers([])).toHaveLength(0);
  });

  test('list_tools returns names + descriptions but NOT parameters', async () => {
    const [listTools] = buildToolDiscoveryHandlers(longTail);
    expect(listTools.name).toBe('list_tools');
    const result = (await listTools.execute({}, ctx)) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'read_file', description: 'Read a file' });
    expect(result[0]).not.toHaveProperty('parameters');
  });

  test('describe_tool returns the exact schema object', async () => {
    const describe = buildToolDiscoveryHandlers(longTail)[1];
    expect(describe.name).toBe('describe_tool');
    const result = (await describe.execute({ name: 'read_file' }, ctx)) as Record<string, unknown>;
    expect(result).toEqual({ name: 'read_file', description: 'Read a file', parameters: fileSchema });
    expect(result.parameters).toBe(fileSchema);
  });

  test('describe_tool throws a helpful error for an unknown name', async () => {
    const describe = buildToolDiscoveryHandlers(longTail)[1];
    await expect(describe.execute({ name: 'nope' }, ctx)).rejects.toThrow(/list_tools/);
  });

  test('describe_tool rejects a non-string name', async () => {
    const describe = buildToolDiscoveryHandlers(longTail)[1];
    await expect(describe.execute({ name: 42 }, ctx)).rejects.toThrow(/must be a string/);
  });

  test('discovery handlers carry the always-core tool_discovery toolId', () => {
    for (const h of buildToolDiscoveryHandlers(longTail)) {
      expect(h.toolId).toBe('tool_discovery');
    }
  });
});

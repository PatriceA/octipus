/**
 * Large MCP results: never cut inside the data.
 *
 * Seen with fintus `get_process_xml` (71,273 chars) and `get_form` (62k): the
 * head/tail preview put its notice in the middle of a JSON string, so the
 * result no longer parsed — even for tools that page themselves.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageRepository } from '@/db/repositories/message-repository';
import { WorkspaceFS } from '@/security/workspace-fs';
import { MCPBridge } from '@/mcp/bridge';
import { resourceHandlers } from '@/mcp/resource-tools';
import { ToolExecutor } from './tool-executor';
import {
  DEFAULT_MCP_MAX_RESULT_CHARS,
  READ_RESULT_TOOL,
  SPILL_DIR,
  mcpResultLimit,
  readSpill,
} from './tool-output-spill';
import type { ToolHandler } from './agent-base';
import type { AgentContext, MCPServer } from './types';

const context: AgentContext = {
  space: null, trigger: 'user', funding: 'own',
  id: 'agent-test', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'user-test',
  model: 'test', topic: '', role: 'general', root: true, status: 'running',
  createdAt: new Date(), updatedAt: new Date(), metadata: {},
};

/** An MCP CallTool result carrying an `n`-char XML page as JSON (quotes, newlines, multibyte). */
function mcpResult(n: number): unknown {
  let xml = '';
  for (let i = 0; xml.length < n; i++) xml += `<task id="t${i}" name="Prüfe Kredit ${i}">\n  <doc>€ ${i}</doc>\n</task>\n`;
  return { content: [{ type: 'text', text: JSON.stringify({ xml: xml.slice(0, n), nextOffset: null }) }] };
}

const getProcessXml = {
  name: 'get_process_xml',
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer' }, maxChars: { type: 'integer', maximum: 60_000 } } },
  annotations: { readOnlyHint: true },
};

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-large-'));
  vi.spyOn(WorkspaceFS, 'forAgent').mockReturnValue(WorkspaceFS.withRoot(root));
  vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
});
afterEach(() => vi.restoreAllMocks());

/** Run one MCP-shaped call through the real executor; return what the model gets. */
async function callThrough(result: unknown, maxResultChars: ToolHandler['maxResultChars'], args: Record<string, unknown> = {}) {
  const exec = new ToolExecutor(context, () => {});
  exec.registerTool({ name: 'mcp_call_tool', toolId: 'agent', description: '', parameters: {}, maxResultChars, execute: async () => result });
  const [msg] = await exec.handleToolCalls([{ id: 'call_80k', name: 'mcp_call_tool', arguments: args }]);
  return { content: msg.content as string, original: JSON.stringify(result) };
}

describe('MCP result over the limit', () => {
  test('an 80k JSON result comes back whole or as valid JSON with the marker on top', async () => {
    const { content, original } = await callThrough(mcpResult(80_000), () => DEFAULT_MCP_MAX_RESULT_CHARS);
    expect(original.length).toBeGreaterThan(80_000);
    expect(content).not.toContain('characters omitted');
    const parsed = JSON.parse(content);
    expect(Object.keys(parsed)[0]).toBe('truncated');
    expect(parsed).toMatchObject({ truncated: true, totalChars: original.length, totalBytes: Buffer.byteLength(original), spillId: 'call_80k' });
    expect(parsed.hint).toContain(READ_RESULT_TOOL);
    expect(original.startsWith(parsed.head)).toBe(true);
    expect(content.length).toBeLessThanOrEqual(DEFAULT_MCP_MAX_RESULT_CHARS);

    // The saved copy is the original, byte for byte.
    const saved = readFileSync(parsed.spillPath);
    expect(parsed.spillPath).toBe(join(root, SPILL_DIR, 'call_80k.txt'));
    expect(saved.equals(Buffer.from(original, 'utf8'))).toBe(true);
    expect(saved.length).toBe(parsed.totalBytes);
  });

  test('mcp_read_result pages the saved copy back together exactly', async () => {
    const { content, original } = await callThrough(mcpResult(150_000), () => DEFAULT_MCP_MAX_RESULT_CHARS);
    const { spillId } = JSON.parse(content);
    const reader = resourceHandlers(new MCPBridge()).find((h) => h.name === READ_RESULT_TOOL)!;
    let text = '';
    let next: number | null = 0;
    while (next !== null) {
      const page = (await reader.execute({ id: spillId, offset: next, length: 25_000 }, context)) as Awaited<ReturnType<typeof readSpill>>;
      expect(page.totalChars).toBe(original.length);
      text += page.content;
      next = page.nextOffset;
      if (next === null) expect(page.done).toBe(true);
    }
    expect(text).toBe(original);
  });

  test('the reader stays inside the spill directory and bounds length', async () => {
    const fs = WorkspaceFS.withRoot(root);
    await expect(readSpill({ id: '../../etc/passwd' }, { fs })).rejects.toThrow(/spillId/);
    await expect(readSpill({ id: 'x/../y' }, { fs })).rejects.toThrow(/spillId/);
    await expect(readSpill({ id: 'missing' }, { fs })).rejects.toThrow(/no saved result/);
    await expect(readSpill({ id: 'a', length: 1_000_000 }, { fs })).rejects.toThrow(/length/);
    await expect(readSpill({ id: 'a', offset: -1 }, { fs })).rejects.toThrow(/offset/);
  });
});

describe('MCP result limit', () => {
  test('a result under the limit passes through unchanged', async () => {
    const { content, original } = await callThrough(mcpResult(45_000), () => DEFAULT_MCP_MAX_RESULT_CHARS);
    expect(original.length).toBeGreaterThan(50_000); // over the generic 50k cut
    expect(content).toBe(original);
  });

  test('a 60k get_process_xml page is never cut', async () => {
    // A full 60,000-char XML page grows past 60k once JSON-escaped and wrapped.
    const server: Pick<MCPServer, 'maxResultChars'> = { maxResultChars: 20_000 };
    const args = { id: 'p1', offset: 0, maxChars: 60_000 };
    const { content, original } = await callThrough(mcpResult(60_000), (a) => mcpResultLimit(server, getProcessXml, a), args);
    expect(original.length).toBeGreaterThan(DEFAULT_MCP_MAX_RESULT_CHARS);
    expect(content).toBe(original);
    // No maxChars passed: the schema's own maximum is the page it may return.
    expect(mcpResultLimit(server, getProcessXml, { id: 'p1' })).toBeGreaterThanOrEqual(120_000);
  });

  test('defaults to at least 64k; per-server and per-tool overrides are honored', () => {
    const plain = { name: 'get_form', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } };
    expect(mcpResultLimit(undefined, plain)).toBeGreaterThanOrEqual(64_000);
    expect(mcpResultLimit({ maxResultChars: 100_000 }, plain)).toBe(100_000);
    expect(mcpResultLimit({ maxResultChars: 100_000, toolMaxResultChars: { get_form: 200_000 } }, plain)).toBe(200_000);
    expect(mcpResultLimit({ maxResultChars: 100_000, toolMaxResultChars: { other: 1 } }, plain)).toBe(100_000);
    // Paging tools: never below their page, but a larger configured limit wins.
    expect(mcpResultLimit({ maxResultChars: 500_000 }, getProcessXml, { maxChars: 1000 })).toBe(500_000);
  });

  test('a per-tool limit applies end to end', async () => {
    const server = { maxResultChars: 1_000_000, toolMaxResultChars: { get_form: 10_000 } };
    const form = { name: 'get_form', inputSchema: {} };
    const { content } = await callThrough(mcpResult(20_000), (a) => mcpResultLimit(server, form, a));
    expect(JSON.parse(content).truncated).toBe(true);
    expect(content.length).toBeLessThanOrEqual(10_000);
  });

  test('bridge resolves the limit from its server config and tool schema', () => {
    const bridge = new MCPBridge();
    const internals = bridge as unknown as { serverConfigs: MCPServer[]; connections: Map<string, unknown> };
    const server = { id: 'fintus', name: 'fintus', command: 'x', isEnabled: true, maxResultChars: 70_000, toolMaxResultChars: { get_form: 90_000 } } as MCPServer;
    internals.serverConfigs = [server];
    expect(bridge.maxResultChars('fintus', 'get_form')).toBe(90_000);
    expect(bridge.maxResultChars('fintus', 'anything')).toBe(70_000);
    internals.connections.set('fintus', { id: 'fintus', server, status: 'connected', tools: [getProcessXml] });
    expect(bridge.maxResultChars('fintus', 'get_process_xml', { maxChars: 60_000 })).toBe(124_096);
  });
});

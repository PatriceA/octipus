/**
 * codemode — scripts run in the real QuickJS sandbox against a fake host, so
 * what is asserted is what the model gets back: only script output, tool
 * errors as rejections, a refused approval ending the script, and no reach
 * beyond the tools the worker holds. See codemode.ts.
 */
import { describe, expect, test, vi } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import type { AgentContext, ToolCall, ToolResult } from '@/core/types';
import { buildCodemodeHandler, type CodemodeHost, scriptableTools } from './codemode';

// No embedding provider in the unit lane: searchTools falls back to keywords.
vi.mock('@/core/rag/embeddings', () => ({
  getEmbeddingService: () => ({ generateEmbedding: async () => { throw new Error('no embedding provider'); } }),
  sha256Hex: (s: string) => s,
}));

const ctx = {} as AgentContext;

function handler(name: string, extra: Partial<ToolHandler> = {}): ToolHandler {
  return {
    name,
    description: `${name} tool\nsecond line`,
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    toolId: name.split('__')[0],
    execute: async () => null,
    ...extra,
  };
}

const FILES: Record<string, string> = {
  'a.log': 'ok\nERROR disk full\nok',
  'b.log': 'ok\nok',
  'c.log': 'ERROR timeout\nok',
};

function host(overrides: Partial<CodemodeHost> = {}): CodemodeHost & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    tools: () => [handler('filesystem__read_file'), handler('shell__run')],
    call: async (call): Promise<ToolResult> => {
      calls.push(call);
      const path = call.arguments.path as string;
      if (!(path in FILES)) return { toolCallId: call.id, result: null, error: `ENOENT: ${path}` };
      return { toolCallId: call.id, result: FILES[path] };
    },
    ...overrides,
  };
}

const run = (h: CodemodeHost, code: string) => buildCodemodeHandler(h).execute({ code }, ctx) as Promise<string>;

describe('codemode', () => {
  test('returns only what the script outputs, not the tool results it read', async () => {
    const h = host();
    const out = await run(h, `
      const paths = ["a.log", "b.log", "c.log"];
      const logs = await Promise.all(paths.map((path) => tools.filesystem__read_file({ path })));
      return logs.flatMap((l) => l.split("\\n")).filter((l) => l.startsWith("ERROR"));
    `);
    expect(h.calls.map((c) => c.arguments.path)).toEqual(['a.log', 'b.log', 'c.log']);
    expect(out).toMatch(/^Script completed \(\d+ms, 3 tool calls\)\./);
    expect(out).toContain('ERROR disk full');
    expect(out).toContain('ERROR timeout');
    expect(out).not.toContain('ok\nok');
  });

  test('every nested call goes through the host with a distinct id', async () => {
    const h = host();
    await run(h, `await tools.filesystem__read_file({ path: "a.log" }); await tools.filesystem__read_file({ path: "b.log" });`);
    expect(new Set(h.calls.map((c) => c.id)).size).toBe(2);
    expect(h.calls.every((c) => c.name === 'filesystem__read_file')).toBe(true);
  });

  test('a tool error rejects inside the script and can be handled there', async () => {
    const out = await run(host(), `
      try { await tools.filesystem__read_file({ path: "missing" }); }
      catch (e) { return "caught: " + e.message; }
    `);
    expect(out).toContain('caught: ENOENT: missing');
  });

  test('a call the pipeline throws on ends the script and propagates', async () => {
    const h = host({
      call: async () => { throw new Error('Permission denied for "shell__run": the approval was not granted'); },
    });
    await expect(run(h, `
      try { await tools.shell__run({ path: "x" }); } catch (e) { text("swallowed"); }
      text("kept going");
    `)).rejects.toThrow(/approval was not granted/);
  });

  test('a failing script reports the error and the output produced before it', async () => {
    await expect(run(host(), `text("step 1"); throw new Error("boom");`)).rejects.toThrow(
      /Script failed \(script.*boom[\s\S]*Output before the failure:\nstep 1/,
    );
  });

  test('the sandbox has no reach of its own', async () => {
    const out = await run(host(), `return [typeof fetch, typeof process, typeof require, typeof setTimeout].join(",");`);
    expect(out).toContain('undefined,undefined,undefined,undefined');
  });

  test('tools the worker does not hold are not callable', async () => {
    const out = await run(host(), `return "git__push" in tools;`);
    expect(out).toContain('false');
  });

  test('describeTool renders a declaration; searchTools finds by keyword without embeddings', async () => {
    const out = await run(host(), `
      const decl = await describeTool("filesystem__read_file");
      const found = await searchTools("shell");
      return { decl, found: found.map((t) => t.name), missing: await describeTool("nope") ?? null };
    `);
    expect(out).toContain('filesystem__read_file(args');
    expect(out).toContain('"shell__run"');
    expect(out).toContain('"missing": null');
  });

  test('store values survive between scripts of the same worker', async () => {
    const h = buildCodemodeHandler(host());
    await h.execute({ code: `store("cursor", 42);` }, ctx);
    const out = await h.execute({ code: `return load("cursor");` }, ctx);
    expect(out).toContain('42');
  });

  test('max_output_tokens trims the middle of long output', async () => {
    const out = await run(host(), `// @options: {"max_output_tokens": 10}\nreturn "x".repeat(500);`);
    expect(out).toMatch(/chars truncated/);
    expect(out.length).toBeLessThan(200);
  });

  test('rejects non-string code', async () => {
    await expect(buildCodemodeHandler(host()).execute({ code: 1 }, ctx)).rejects.toThrow(/must be a string/);
  });
});

describe('scriptableTools', () => {
  test('keeps real tools, drops meta-tools, discovery, final tools and itself', () => {
    const kept = scriptableTools([
      handler('filesystem__read_file'),
      handler('mcp_call_tool', { toolId: 'mcp' }),
      handler('spawn_child', { toolId: undefined }),
      handler('list_tools', { toolId: 'tool_discovery' }),
      handler('finish', { toolId: 'x', final: true }),
      handler('codemode', { toolId: undefined }),
    ]).map((h) => h.name);
    expect(kept).toEqual(['filesystem__read_file', 'mcp_call_tool']);
  });
});

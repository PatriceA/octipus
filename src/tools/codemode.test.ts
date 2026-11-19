/**
 * codemode — scripts run in the real QuickJS sandbox against a fake host, so
 * what is asserted is what the model gets back: only script output, tool
 * errors as rejections, a refused approval ending the script, and no reach
 * beyond the tools the worker holds. See codemode.ts.
 */
import { describe, expect, test, vi } from 'vitest';
import type { ToolHandler } from '@/core/agent-base';
import type { AgentContext, ToolCall, ToolResult } from '@/core/types';
import { buildCodemodeHandler, compactCodemodeTools, type CodemodeHost, scriptableTools, scriptTimeoutMs } from './codemode';

// No embedding provider in the unit lane: searchTools falls back to keywords.
vi.mock('@/core/rag/embeddings', () => ({
  getEmbeddingService: () => ({ generateEmbedding: async () => { throw new Error('no embedding provider'); } }),
  sha256Hex: (s: string) => s,
}));

const ctx = {} as AgentContext;

test('compact schemas preserve coordination, discovery and final tools, not core or direct MCP tools', () => {
  const tools = [handler('shell__run'), handler('mcp__server__read', { toolId: 'mcp' }),
    handler('codemode', { toolId: undefined }), handler('spawn_child', { toolId: undefined }),
    handler('list_tools', { toolId: 'tool_discovery' }), handler('describe_tool', { toolId: 'tool_discovery' }),
    handler('submit', { toolId: 'review', final: true })];
  expect(compactCodemodeTools(tools).map(t => t.name)).toEqual(['codemode', 'spawn_child', 'list_tools', 'describe_tool', 'submit']);
  expect(tools).toHaveLength(7);
  const pipeline = handler('create_pipeline', { toolId: undefined, discoverOnly: true });
  expect(compactCodemodeTools([...tools, pipeline], true)).not.toContain(pipeline);
  expect(compactCodemodeTools([...tools, pipeline])).toContain(pipeline);
});

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

  test('a script stopped mid-call waits for that call and says its effects stand', async () => {
    // The call stops the script itself (as a timeout or an abort would), so it is surely in flight then.
    const stop = new AbortController();
    let finished = false;
    const h = host({
      signal: stop.signal,
      call: async (call) => {
        stop.abort();
        await new Promise((r) => setTimeout(r, 200));
        finished = true;
        return { toolCallId: call.id, result: 'done' };
      },
    });
    const err = await run(h, `await tools.shell__run({ path: "x" });`).catch((e: Error) => e);
    expect(finished).toBe(true);
    expect((err as Error).message).toMatch(/Script failed \(aborted/);
    expect((err as Error).message).toMatch(/1 tool call was still running when the script stopped and finished afterwards/);
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

describe('routed script tools', () => {
  const routed = [{
    name: 'mcp__gh__get_pr',
    description: '[MCP:GitHub] Get a pull request',
    parameters: { type: 'object', properties: { number: { type: 'number' } } },
    via: 'mcp_call_tool',
    wrap: (args: Record<string, unknown>) => ({ server_id: 'gh', tool_name: 'get_pr', arguments: args }),
  }];

  test('a call is re-addressed to the handler it routes through, with wrapped arguments', async () => {
    const calls: ToolCall[] = [];
    const h = host({
      tools: () => [handler('mcp_call_tool', { toolId: 'mcp' })],
      routedTools: () => routed,
      call: async (call) => { calls.push(call); return { toolCallId: call.id, result: { content: [{ type: 'text', text: 'PR 7' }] } }; },
    });
    const out = await run(h, `
      const found = await searchTools("pull request");
      const decl = await describeTool("mcp__gh__get_pr");
      const res = await tools.mcp__gh__get_pr({ number: 7 });
      return { found: found.map((t) => t.name), decl, text: res.content[0].text };
    `);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'mcp_call_tool', arguments: { server_id: 'gh', tool_name: 'get_pr', arguments: { number: 7 } } });
    expect(out).toContain('"mcp__gh__get_pr"');
    expect(out).toContain('mcp__gh__get_pr(args');
    expect(out).toContain('PR 7');
  });

  test('without the handler it routes through, a routed tool does not exist', async () => {
    const out = await run(host({ routedTools: () => routed }), `return "mcp__gh__get_pr" in tools;`);
    expect(out).toContain('false');
  });
});

describe('codemode execution budget', () => {
  // The CLI bridge bounds each call by the handler's executionTimeoutMs; a
  // budget shorter than the script's would abandon it while its calls go on.
  const budget = (code: unknown) => (buildCodemodeHandler(host()).executionTimeoutMs as (args: Record<string, unknown>) => number)({ code });

  test('follows the script timeout_ms option', () => {
    expect(budget('// @options: {"timeout_ms": 45000}\nreturn 1;')).toBe(45_000);
    expect(scriptTimeoutMs('// @options: {"timeout_ms": 45000}\nreturn 1;')).toBe(45_000);
  });

  test('is the maximum without an option, past the cap, or for source the parser rejects', () => {
    expect(budget('return 1;')).toBe(300_000);
    expect(budget('// @options: {"timeout_ms": 900000}\nreturn 1;')).toBe(300_000);
    expect(budget('// @options: {not json}\nreturn 1;')).toBe(300_000);
    expect(budget(42)).toBe(300_000);
  });
});

/**
 * `codemode` — the model writes one JavaScript script that calls its tools,
 * instead of one tool call per LLM round trip.
 *
 * The token argument: every tool result a model-issued call returns is
 * re-sent on every later request of the run. A script that reads ten files,
 * greps a log and keeps the three lines that matter returns those three lines;
 * the rest never enters the conversation. Independent calls run in parallel
 * (`Promise.all`) inside the same single round trip.
 *
 * The script runs in `@earendil-works/pi-codemode`'s QuickJS-in-WebAssembly
 * sandbox on a worker thread: no network, filesystem, timers or modules — its
 * only capability is calling the tools handed to it. Each of those calls goes
 * through `ToolExecutor.runNestedCall`, the same pipeline a model-issued call
 * takes (permission, flow guard, approval, hooks, audit, work-stream events),
 * so a script can reach exactly what the agent could reach directly, and no
 * more.
 *
 * The description is static on purpose: it never lists tools, so it does not
 * grow with the role's tool set and stays inside the cacheable prompt prefix.
 * Scripts find tools with `searchTools()` / `describeTool()` / `ALL_TOOLS`.
 */

import { randomUUID } from 'node:crypto';
import {
  type CodemodeTool,
  CodemodeSandbox,
  CodemodeSourceError,
  type CodemodeJsonSchema,
  parseCodemodeSource,
  renderDeclarations,
} from '@earendil-works/pi-codemode';
import type { ToolHandler } from '@/core/agent-base';
import { TOOL_DISCOVERY_TOOL_ID } from '@/core/agent/tool-split';
import type { ToolCall, ToolResult } from '@/core/types';
import { stripWorkStreamMeta } from '@/shared/work-stream';
import { rankToolsByQuery, type ToolSummary } from '@/tools/tool-search';
import { toolLogger } from '@/utils/logger';

export const CODEMODE_TOOL_NAME = 'codemode';

/** QuickJS heap cap. The VM runs inside the server process's worker pool. */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** Matches the rough chars-per-token the rest of the codebase budgets with. */
const CHARS_PER_TOKEN = 4;
const SEARCH_LIMIT = 8;

/** What the codemode tool needs from the worker it runs in. */
export interface CodemodeHost {
  /** The worker's callable tools right now (blocked tools already removed). */
  tools(): ToolHandler[];
  /** Run one call through the worker's full tool pipeline. */
  call(call: ToolCall): Promise<ToolResult>;
  /** The worker's abort signal. */
  signal?: AbortSignal;
}

const DESCRIPTION = [
  'Run a JavaScript script that calls your tools. Only what the script outputs comes back to you, so use it to chain several calls, run independent calls in parallel (Promise.all), or filter and aggregate large results before reading them. For a single call, call the tool directly.',
  '',
  '`code` is raw JavaScript (no markdown fence), run as the body of an async function in a sandbox with no network, filesystem, timers or modules — only these:',
  '- `await tools.<name>(args)` calls any tool you can call directly, e.g. `tools.filesystem__read_file({ path })`. Resolves to the tool result; rejects with its error.',
  '- `await searchTools(query)` → `[{ name, description }]`; `await describeTool(name)` → its TypeScript signature; `ALL_TOOLS` lists every callable tool.',
  '- `text(value)`, `console.log(...)` and `return value` produce the output.',
  '- `store(key, value)` / `load(key)` keep small JSON values across codemode calls in this run.',
  'Optional first line: `// @options: {"timeout_ms": 60000, "max_output_tokens": 2000}`.',
  'Tool calls are real and pass the normal permission checks; a failed script keeps the effects of the calls it already made.',
].join('\n');

/**
 * Handlers a script may call: real tools only. Orchestration meta-tools (no
 * `toolId`: spawn_child, collect_children, plans, status updates) change the
 * agent's own control flow and stay model-issued; the discovery pair has
 * in-script equivalents; `final` tools end the run.
 */
export function scriptableTools(handlers: ToolHandler[]): ToolHandler[] {
  return handlers.filter(
    (h) =>
      h.name !== CODEMODE_TOOL_NAME &&
      h.toolId !== undefined &&
      h.toolId !== TOOL_DISCOVERY_TOOL_ID &&
      h.final !== true,
  );
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** Ranking without an embedding provider: count query words in name + description. */
function keywordRank(tools: ToolSummary[], query: string, limit: number): ToolSummary[] {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
  return tools
    .map((t) => {
      const hay = `${t.name} ${t.description}`.toLowerCase();
      return { t, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.t);
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - 2 * half;
  return `${text.slice(0, half)}\n…${omitted} chars truncated…\n${text.slice(-half)}`;
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function buildCodemodeHandler(host: CodemodeHost): ToolHandler {
  // Per worker: a run's scripts share state, a new run starts empty.
  const store: Record<string, unknown> = {};

  return {
    name: CODEMODE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript source, the body of an async function.' },
      },
      required: ['code'],
    },
    previewParam: 'code',
    execute: async (args) => {
      if (typeof args.code !== 'string') {
        throw new Error(`codemode: 'code' must be a string, got ${typeof args.code}.`);
      }
      let source: ReturnType<typeof parseCodemodeSource>;
      try {
        source = parseCodemodeSource(args.code);
      } catch (err) {
        if (err instanceof CodemodeSourceError) throw new Error(`codemode: ${err.message}`);
        throw err;
      }

      const handlers = scriptableTools(host.tools());
      const byName = new Map(handlers.map((h) => [h.name, h]));
      const runId = randomUUID().slice(0, 8);
      let seq = 0;
      // A call the pipeline THROWS on (a refused approval aborts the agent) must
      // end the script and propagate — a script could otherwise catch it and
      // carry on past a human's "no".
      let fatal: unknown;
      const abort = new AbortController();
      const onHostAbort = () => abort.abort();
      host.signal?.addEventListener('abort', onHostAbort, { once: true });

      const tools: CodemodeTool[] = handlers.map((h) => ({
        name: h.name,
        description: firstLine(h.description),
        inputSchema: h.parameters as CodemodeJsonSchema,
        execute: async (input) => {
          const call: ToolCall = {
            id: `codemode-${runId}-${++seq}`,
            name: h.name,
            arguments: (input ?? {}) as Record<string, unknown>,
          };
          let result: ToolResult;
          try {
            result = await host.call(call);
          } catch (err) {
            fatal ??= err;
            abort.abort();
            throw err;
          }
          if (result.error) throw new Error(result.error);
          return stripWorkStreamMeta(result.result) ?? null;
        },
      }));

      const summaries = (): ToolSummary[] => handlers.map((h) => ({ name: h.name, description: firstLine(h.description) }));
      const globals: CodemodeTool[] = [
        {
          name: 'searchTools',
          description: 'Tools ranked by relevance to what you want to do.',
          spread: true,
          signature: '(query: string, limit?: number): Promise<{ name: string; description: string }[]>',
          execute: async (callArgs) => {
            const [query, limit] = callArgs as [unknown, unknown];
            if (typeof query !== 'string') throw new TypeError('searchTools(query): query must be a string');
            const n = typeof limit === 'number' && limit > 0 ? Math.floor(limit) : SEARCH_LIMIT;
            return (await rankToolsByQuery(summaries(), query, n)) ?? keywordRank(summaries(), query, n);
          },
        },
        {
          name: 'describeTool',
          description: "A tool's description and TypeScript declaration, or undefined.",
          spread: true,
          signature: '(name: string): Promise<string | undefined>',
          execute: (callArgs) => {
            const [name] = callArgs as [unknown];
            const handler = typeof name === 'string' ? byName.get(name) : undefined;
            if (!handler) return undefined;
            return renderDeclarations({
              tools: [{ name: handler.name, description: handler.description, inputSchema: handler.parameters as CodemodeJsonSchema, execute: () => undefined }],
            });
          },
        },
      ];

      const started = Date.now();
      const sandbox = new CodemodeSandbox({ tools, globals, memoryLimitBytes: MEMORY_LIMIT_BYTES });
      let result: Awaited<ReturnType<CodemodeSandbox['execute']>>;
      try {
        result = await sandbox.execute(source.code, {
          signal: abort.signal,
          timeoutMs: source.options.timeoutMs ?? Infinity,
          store,
        });
      } finally {
        host.signal?.removeEventListener('abort', onHostAbort);
        await sandbox.close();
      }
      if (fatal !== undefined) throw fatal;

      const parts: string[] = [];
      for (const item of result.output) {
        parts.push(item.type === 'text' ? item.text : `[image ${item.mimeType} omitted — return a file path instead]`);
      }
      if (result.ok && result.value !== undefined) parts.push(formatValue(result.value));
      let output = parts.join('\n');
      if (source.options.maxOutputTokens !== undefined) {
        output = truncateMiddle(output, source.options.maxOutputTokens * CHARS_PER_TOKEN);
      }
      const calls = result.calls.length;
      const header = `${Date.now() - started}ms, ${calls} tool call${calls === 1 ? '' : 's'}`;

      toolLogger.info(
        { ok: result.ok, calls, failedCalls: result.calls.filter((c) => c.status === 'error').length, ms: Date.now() - started, outputChars: output.length },
        'codemode script finished',
      );

      if (!result.ok) {
        const error = result.error.stack ?? `${result.error.name ?? 'Error'}: ${result.error.message}`;
        throw new Error(`Script failed (${result.error.kind}, ${header}): ${error}${output ? `\nOutput before the failure:\n${output}` : ''}`);
      }
      for (const key of result.storeWrites.delete) delete store[key];
      Object.assign(store, result.storeWrites.set);
      return `Script completed (${header}).\n${output}`;
    },
  };
}

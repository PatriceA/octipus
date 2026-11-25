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

import { createHash, randomUUID } from 'node:crypto';
import {
  type CodemodeTool,
  CodemodeSandbox,
  CodemodeSourceError,
  type CodemodeJsonSchema,
  parseCodemodeSource,
  renderDeclarations,
  toCodemodeIdentifier,
} from '@earendil-works/pi-codemode';
import type { RoutedScriptTool, ToolHandler } from '@/core/agent-base';
import { TOOL_DISCOVERY_TOOL_ID } from '@/core/agent/tool-split';
import type { ToolCall, ToolResult } from '@/core/types';
import { stripWorkStreamMeta } from '@/shared/work-stream';
import { takeToolMedia, toolTextWithMedia } from '@/core/media/tool-media';
import type { MediaRef } from '@/core/types';
import { wrapUntrusted } from '@/security/untrusted-envelope';
import { rankToolsByQuery, type ToolSummary } from '@/tools/tool-search';
import { toolLogger } from '@/utils/logger';

export const CODEMODE_TOOL_NAME = 'codemode';

/** QuickJS heap cap. The VM runs inside the server process's worker pool. */
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
/** A script runs at most this long; `timeout_ms` may only shorten it. */
const MAX_TIMEOUT_MS = 300_000;
/** Matches the rough chars-per-token the rest of the codebase budgets with. */
const CHARS_PER_TOKEN = 4;
const SEARCH_LIMIT = 8;
export const CODEMODE_DEFAULT_OUTPUT_TOKENS = 2_000;
export const CODEMODE_MAX_OUTPUT_TOKENS = 32_000;
export const CODEMODE_MAX_SOURCE_BYTES = 256 * 1024;

/** What the codemode tool needs from the worker it runs in. */
export interface CodemodeHost {
  /** The worker's callable tools right now (blocked tools already removed). */
  tools(): ToolHandler[];
  /**
   * Script-only tools that are not registered handlers (the MCP bridge's
   * `codemode`/`deferred` tools). Each is offered only while the worker holds
   * the handler it routes through.
   */
  routedTools?(): RoutedScriptTool[];
  /** Run one call through the worker's full tool pipeline. */
  call(call: ToolCall): Promise<ToolResult>;
  /** The worker's abort signal. */
  signal?: AbortSignal;
}

const DESCRIPTION = [
  'Run a JavaScript script that calls your tools. Tool definitions are loaded on demand: use searchTools and describeTool inside a script to find a tool and learn its arguments, then call it through tools. Use this for single calls too. Only what the script outputs comes back to you; chain calls, run independent calls in parallel (Promise.all), or filter large results before returning them.',
  '',
  '`code` is raw JavaScript (no markdown fence), run as the body of an async function in a sandbox with no network, filesystem, timers or modules — only these:',
  '- `await tools.<name>(args)` calls a registered tool, including tools whose schemas are omitted from the initial list, e.g. `tools.filesystem__read_file({ path })`. Resolves to the tool result; rejects with its error.',
  '- `ALL_TOOLS` lists script-callable tools only. Read-only status tools can run in scripts. Direct-only coordination tools (for example spawn_child or resume_pipeline) must be called outside codemode. The CLI bridge wrapper call_discovered_tool is not a script tool: call the discovered tools.<name>(args) directly inside scripts.',
  '- `ALL_TOOLS` is an array of objects `{name: string, description: string}`, NOT strings. Example: `ALL_TOOLS.filter(t => t.name.includes("calendar")).map(t => t.name)`. `await searchTools(query)` returns the same shape; `await describeTool(name)` returns its TypeScript signature or undefined. Describe tools before guessing argument names.',
  '- `text(value)`, `console.log(...)` and `return value` produce the output.',
  '- `await showToolImage(toolResult)` shows the images from a tool result, e.g. `await showToolImage(await tools.vision__view_image({path}))`. Images are not shown unless selected this way; text output does not select images.',
  '- `store(key, value)` / `load(key)` keep small JSON values across codemode calls in this run.',
  'Optional first line: `// @options: {"timeout_ms": 60000, "max_output_tokens": 2000}`.',
  'Source limit: 256 KiB UTF-8. Text output defaults to 2000 estimated tokens (characters / 4), with an explicit maximum of 32000 before the worker\'s own result ceiling. Larger output is visibly truncated, including errors. `max_output_tokens: 0` suppresses successful text; errors retain a bounded diagnostic and selected images use the media channel. Time limit is at most 5 minutes; there are no timers, fetch, filesystem or imports in scripts.',
  'Await every tool call. For parallel filtering, await Promise.all(items.map(async item => ...)) and filter the resolved values; Array.filter(async ...) does not wait. Promise.allSettled error reasons need `.message` to print usefully. A completed script does not prove domain success: inspect tool results for reported errors.',
  'Tool calls are real and pass the normal permission checks; a failed script keeps the effects of the calls it already made.',
].join('\n');

/**
 * Handlers a script may call: grouped tools and explicitly read-only helpers.
 * Coordination handlers that change control flow stay model-issued; discovery
 * has in-script equivalents, and final handlers end the run.
 */
export function scriptableTools(handlers: ToolHandler[]): ToolHandler[] {
  return handlers.filter(
    (h) =>
      h.name !== CODEMODE_TOOL_NAME &&
      (h.toolId !== undefined || h.replaySafety === 'read_only') &&
      h.toolId !== TOOL_DISCOVERY_TOOL_ID &&
      h.final !== true,
  );
}

/** Keep orchestration/final handlers and discovery visible; ordinary schemas
 * stay in the executor and are described on demand inside codemode. This is
 * independent of lazy discovery's core groups and provider capability hints. */
export function compactCodemodeTools(handlers: ToolHandler[], lazy = false): ToolHandler[] {
  const hidden = new Set(scriptableTools(handlers));
  return handlers.filter((handler) => !hidden.has(handler) && !(lazy && handler.discoverOnly));
}

interface ScriptEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** The registered call this script call becomes. */
  address: (input: Record<string, unknown>) => Pick<ToolCall, 'name' | 'arguments'>;
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
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const omitted = text.length - 2 * half;
  return `${text.slice(0, half)}\n…${omitted} chars truncated…\n${text.slice(-half)}`;
}

function formatValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * How long a script may run: its `timeout_ms` option, capped at the maximum.
 * Source the parser rejects fails in `execute` straight away, so the maximum
 * is only an upper bound there.
 */
export function scriptTimeoutMs(code: unknown): number {
  if (typeof code !== 'string') return MAX_TIMEOUT_MS;
  try {
    return Math.min(parseCodemodeSource(code).options.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof CodemodeSourceError) return MAX_TIMEOUT_MS;
    throw err;
  }
}

export function buildCodemodeHandler(host: CodemodeHost): ToolHandler {
  // Per worker: a run's scripts share state, a new run starts empty.
  const store: Record<string, unknown> = Object.create(null);

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
    // A transport that bounds each call (the CLI bridge) must wait as long as
    // the script may run, or it abandons a script whose tool calls go on.
    executionTimeoutMs: (args) => scriptTimeoutMs(args.code),
    execute: async (args) => {
      const extra = Object.keys(args).filter(key => key !== 'code');
      if (extra.length) throw new Error(truncateMiddle(`codemode: unknown argument${extra.length === 1 ? '' : 's'} ${extra.join(', ')}. Pass only code; put timeout_ms and max_output_tokens in the first // @options: line.`, 1000));
      if (typeof args.code !== 'string') {
        throw new Error(`codemode: 'code' must be a string, got ${typeof args.code}.`);
      }
      if (Buffer.byteLength(args.code, 'utf8') > CODEMODE_MAX_SOURCE_BYTES) {
        throw new Error(`codemode: source exceeds ${CODEMODE_MAX_SOURCE_BYTES} bytes (256 KiB UTF-8). Keep data in tools or files and return a summary.`);
      }
      if (args.code.trimStart().startsWith('```')) throw new Error('codemode: provide raw JavaScript without Markdown fences.');
      if (args.code.trimStart().startsWith('// @exec:')) throw new Error('codemode: use a first line // @options: with timeout_ms and max_output_tokens; @exec is not supported.');
      let source: ReturnType<typeof parseCodemodeSource>;
      try {
        source = parseCodemodeSource(args.code);
      } catch (err) {
        if (err instanceof CodemodeSourceError) throw new Error(truncateMiddle(`codemode: ${err.message}`, 1000));
        throw err;
      }

      const handlers = scriptableTools(host.tools());
      const handlerNames = new Set(handlers.map((h) => h.name));
      // One entry per name a script can call: the worker's own handlers, then
      // routed tools — re-addressed to the handler they route through, so they
      // can never reach past what the worker itself may call.
      const entries: ScriptEntry[] = [
        ...handlers.map((h) => ({
          name: h.name,
          description: h.description,
          parameters: h.parameters,
          address: (input: Record<string, unknown>) => ({ name: h.name, arguments: input }),
        })),
        ...(host.routedTools?.() ?? [])
          .filter((r) => handlerNames.has(r.via) && !handlerNames.has(r.name))
          .map((r) => ({
            name: r.name,
            description: r.description,
            parameters: r.parameters,
            address: (input: Record<string, unknown>) => ({ name: r.via, arguments: r.wrap(input) }),
          })),
      ];
      const canonicalNames = new Set(entries.map(e => e.name));
      const counts = new Map<string, number>();
      for (const entry of entries) {
        const name = toCodemodeIdentifier(entry.name);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const usedNames = new Set<string>();
      const namedEntries = entries.map(entry => {
        let jsName = toCodemodeIdentifier(entry.name);
        if ((counts.get(jsName) ?? 0) > 1) jsName += `_${createHash('sha256').update(entry.name).digest('hex').slice(0, 12)}`;
        while (usedNames.has(jsName) || (canonicalNames.has(jsName) && jsName !== entry.name)) jsName += '_';
        usedNames.add(jsName);
        return { ...entry, jsName };
      });
      const byName = new Map(namedEntries.flatMap(e => [[e.name, e], [e.jsName, e]] as Array<[string, typeof e]>));
      const runId = randomUUID().slice(0, 8);
      let seq = 0;
      // A call the pipeline THROWS on (a refused approval aborts the agent) must
      // end the script and propagate — a script could otherwise catch it and
      // carry on past a human's "no".
      let fatal: unknown;
      const abort = new AbortController();
      // Nested calls still running when the script ends (a timeout or an abort
      // leaves them: an approval wait or a slow tool is not cancelled). Awaited
      // below, so the model is never told a script failed while its calls go on.
      const inFlight = new Map<string, Promise<unknown>>();
      // Envelope labels of what this script's calls read (ToolResult.untrustedSource):
      // its output, and its failure, may carry that content.
      const untrusted = new Set<string>();
      // Keep trusted tool media out of JS text and forward it through the same
      // typed channel the outer executor uses for direct tool calls.
      const shownMedia: MediaRef[] = [];
      const availableMedia = new Map<string, MediaRef[]>();
      const onHostAbort = () => abort.abort();
      host.signal?.addEventListener('abort', onHostAbort, { once: true });

      const tools: CodemodeTool[] = namedEntries.map((e) => ({
        name: e.name,
        jsName: e.jsName,
        description: firstLine(e.description),
        inputSchema: e.parameters as CodemodeJsonSchema,
        execute: async (input) => {
          if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
            throw new TypeError(`${e.name} expects one argument object, not ${input === null ? 'null' : Array.isArray(input) ? 'an array' : typeof input}. Use describeTool("${e.name}") for its signature.`);
          }
          const args = (input ?? {}) as Record<string, unknown>;
          const required = Array.isArray(e.parameters.required) ? e.parameters.required.filter((key): key is string => typeof key === 'string') : [];
          const missing = required.filter(key => !Object.hasOwn(args, key));
          if (missing.length) throw new TypeError(`${e.name} is missing required argument${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Use describeTool("${e.name}") for its signature.`);
          const call: ToolCall = {
            id: `codemode-${runId}-${++seq}`,
            ...e.address(args),
          };
          let result: ToolResult;
          const pending = host.call(call);
          inFlight.set(call.id, pending.then(() => undefined, () => undefined));
          try {
            result = await pending;
          } catch (err) {
            fatal ??= err;
            abort.abort();
            throw err;
          } finally {
            inFlight.delete(call.id);
          }
          if (result.untrustedSource) untrusted.add(result.untrustedSource);
          if (result.error) throw new Error(result.error);
          const taken = takeToolMedia(result.result);
          if (taken.media.length) {
            const token = randomUUID();
            availableMedia.set(token, taken.media);
            const value = stripWorkStreamMeta(taken.result) ?? null;
            return { ...(value && typeof value === 'object' ? value : { value }), __codemodeMedia: token };
          }
          return stripWorkStreamMeta(taken.result) ?? null;
        },
      }));

      const summaries = (): ToolSummary[] => namedEntries.map((e) => ({ name: e.jsName, description: firstLine(e.description) }));
      const globals: CodemodeTool[] = [
        {
          name: 'showToolImage', description: 'Show images from a tool result. Only explicitly selected images reach the model.',
          spread: true, signature: '(toolResult: unknown): Promise<void>',
          execute: (args) => {
            const [result] = args as [unknown];
            const token = result && typeof result === 'object' && '__codemodeMedia' in result ? result.__codemodeMedia : undefined;
            const media = typeof token === 'string' ? availableMedia.get(token) : undefined;
            if (!media) throw new Error('showToolImage expects an image-bearing tool result from this script.');
            shownMedia.push(...media);
          },
        },
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
            const entry = typeof name === 'string' ? byName.get(name) : undefined;
            if (!entry) return undefined;
            return renderDeclarations({
              tools: [{ name: entry.jsName, description: entry.description, inputSchema: entry.parameters as CodemodeJsonSchema, execute: () => undefined }],
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
          timeoutMs: Math.min(source.options.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS),
          store,
        });
      } finally {
        host.signal?.removeEventListener('abort', onHostAbort);
        await sandbox.close();
      }
      const lateCalls = [...inFlight.keys()];
      await Promise.all(inFlight.values());
      if (fatal !== undefined) throw fatal;

      const outputBudget = Math.min(source.options.maxOutputTokens ?? CODEMODE_DEFAULT_OUTPUT_TOKENS, CODEMODE_MAX_OUTPUT_TOKENS) * CHARS_PER_TOKEN;
      const parts: string[] = [];
      if (outputBudget > 0) {
        for (const item of result.output) parts.push(item.type === 'text' ? item.text : `[image ${item.mimeType} omitted — return a file path instead]`);
        if (result.ok && result.value !== undefined) parts.push(formatValue(result.value));
      }
      const output = truncateMiddle(parts.join('\n'), outputBudget);
      const calls = result.calls.length;
      const header = `${Date.now() - started}ms, ${calls} tool call${calls === 1 ? '' : 's'}`;
      // The script's own text goes in the untrusted envelope when one of its
      // calls read outside content; our status line stays outside it.
      const wrapped = (text: string) => (untrusted.size ? wrapUntrusted(`codemode script (${[...untrusted].join(', ')})`, text) : text);

      toolLogger.info(
        { ok: result.ok, calls, failedCalls: result.calls.filter((c) => c.status === 'error').length, ms: Date.now() - started, outputChars: output.length },
        'codemode script finished',
      );

      if (!result.ok) {
        let error = (result.error.stack ?? `${result.error.name ?? 'Error'}: ${result.error.message}`)
          .replace('ALL_TOOLS lists every tool', 'ALL_TOOLS lists script-callable tools');
        const missing = /tools\.([A-Za-z0-9_]+) does not exist/.exec(error)?.[1];
        if (missing === 'call_discovered_tool') {
          error += '\ncall_discovered_tool is an outer CLI bridge wrapper, not a script tool. Use searchTools/describeTool, then call the discovered tools.<name>(args) directly inside codemode.';
        } else if (missing && host.tools().some(tool => tool.name === missing)) {
          error += `\n${missing} is a direct-only coordination tool. Call it outside codemode using its advertised tool interface.`;
        }
        // No timing here, unlike the success header: the executor blocks a
        // tool after the SAME error three times running, and a wall time in the
        // message made every repeat of one failure look different.
        const late = lateCalls.length > 0
          ? `\n${lateCalls.length} tool call${lateCalls.length === 1 ? ' was' : 's were'} still running when the script stopped and finished afterwards: their effects stand.`
          : '';
        // Keep a bounded diagnostic even with output disabled. A thrown Error's
        // message is output too; it must not bypass the response budget.
        const detail = truncateMiddle(`${error}${output ? `\nOutput before the failure:\n${output}` : ''}`, Math.max(outputBudget, 1000));
        throw new Error(`Script failed (${result.error.kind}, ${calls} tool call${calls === 1 ? '' : 's'}): ${untrusted.size ? `\n${wrapped(detail)}` : detail}${late}`);
      }
      for (const key of result.storeWrites.delete) delete store[key];
      Object.assign(store, result.storeWrites.set);
      const message = `Script completed (${header}).\n${wrapped(output)}`;
      return shownMedia.length ? toolTextWithMedia(message, shownMedia) : message;
    },
  };
}

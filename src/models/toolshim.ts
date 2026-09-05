/**
 * Toolshim — last-resort, model-based tool-call recovery.
 *
 * When the primary model returns prose that *should* have been a tool call (no
 * structured `toolCalls`, and the cheap text→toolcall fallbacks in
 * `agent-worker.parseTextToolCalls` all failed), we ask a small bound
 * `tool_translation` model to convert the prose + the available tool schemas
 * into one valid tool call — instead of dead-ending or burning a
 * `TOOL_CALL_INVALID` retry.
 *
 * This is the model-based escalation of the existing regex/JSON fallbacks
 * (Goose's pattern: pair a weak model with a small translator). It is the LAST
 * resort because it costs a whole extra LLM call — guard hard at the call site:
 * only when the `tool_translation` topic is bound, tools are available, and at
 * most once per iteration.
 *
 * Design: the LLM call is INJECTED (`complete`) so this module is pure and
 * unit-testable without mocking providers (mock.module leaks process-wide in
 * bun — see the discovery/notes test leak). `agent-worker` owns provider
 * routing and passes a closure bound to the resolved translator model.
 */

import type { ToolCall } from '@/core/types';
import { modelLogger } from '@/utils/logger';

/**
 * Structural leftovers of a tool call the model tried, and failed, to emit —
 * a half-serialized envelope, a provider-specific block, a fenced call.
 */
const TOOL_CALL_MARKERS: RegExp[] = [
  /"(?:name|tool|tool_name|function|recipient_name)"\s*:/i,
  /"(?:arguments|parameters|args|tool_input)"\s*:/i,
  /<\s*(?:tool_call|function_call|tool_code|invoke)\b/i,
  /```\s*(?:tool_code|tool_call|json)\b/i,
  /\bfunctions?\.[a-z0-9_]+\s*\(/i,
];

/**
 * Does this prose look like a tool call the model failed to emit natively?
 *
 * The toolshim costs a whole extra LLM call, so it must not fire on prose that
 * was never trying to be a tool call — i.e. on an ordinary final answer, which
 * is the normal way a turn ends. Historically it did: a daily 1-iteration cron
 * whose root agent simply answered in plain text still paid for a translator
 * call, and when that translator was a cold local model the run sat ~15 min
 * past its finished answer.
 *
 * Two signals, both cheap and local:
 *  - the prose names a tool that is actually advertised to this agent, or
 *  - it carries the structural debris of a botched call envelope.
 *
 * Tool names are matched on identifier boundaries so `spawn_child` matches the
 * word but not `respawn_children`. A false positive costs one bounded shim call
 * (today's behaviour); a false negative costs the recovery — so when in doubt
 * the markers above are deliberately broad.
 */
export function proseShowsToolIntent(prose: string, toolNames: Iterable<string>): boolean {
  if (!prose?.trim()) return false;
  if (TOOL_CALL_MARKERS.some((rx) => rx.test(prose))) return true;
  for (const name of toolNames) {
    if (!name) continue;
    // Identifier boundary: not preceded/followed by a name character.
    const rx = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
    if (rx.test(prose)) return true;
  }
  return false;
}

/** The tool schema shape we hand the translator — same fields the providers see. */
export interface ToolShimSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface TranslateToToolCallOptions {
  /** The primary model's prose that should have been a tool call. */
  text: string;
  /** Schemas of the tools currently advertised to the agent. */
  tools: ToolShimSchema[];
  /**
   * Performs the translator LLM call and returns the raw assistant content.
   * Injected so the prompt/parse/validate logic stays pure and testable.
   */
  complete: (prompt: string) => Promise<string>;
  /** True iff a tool name is registered and callable (guards hallucinated names). */
  isRegistered: (name: string) => boolean;
}

const SENTINEL_NONE = 'none';

/**
 * Build the translator prompt: the available tool schemas + the prose, and a
 * strict instruction to emit a single JSON tool call (or a "none" sentinel).
 */
export function buildToolShimPrompt(text: string, tools: ToolShimSchema[]): string {
  const toolList = tools
    .map((t) => {
      const params = t.parameters ? JSON.stringify(t.parameters) : '{}';
      return `- ${t.name}: ${t.description ?? ''}\n  parameters (JSON schema): ${params}`;
    })
    .join('\n');

  return [
    'You are a tool-call translator. Another AI model was supposed to call a tool but',
    'instead wrote a prose message. Convert that message into a single tool call using',
    'one of the available tools below.',
    '',
    'Available tools:',
    toolList,
    '',
    "The model's message:",
    '"""',
    text,
    '"""',
    '',
    'Respond with ONLY a single JSON object and nothing else, in exactly this shape:',
    '{"name": "<tool_name>", "arguments": { ...arguments matching that tool\'s schema... }}',
    '',
    `If no available tool matches the message, respond with exactly: {"${SENTINEL_NONE}": true}`,
    'Do not include explanations, markdown fences, or any text outside the JSON object.',
  ].join('\n');
}

/**
 * Extract the first balanced top-level JSON object from arbitrary text,
 * respecting strings/escapes. Returns null if none found.
 */
function extractFirstJsonObject(content: string): string | null {
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < content.length; j++) {
      const ch = content[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return content.slice(i, j + 1);
      }
    }
  }
  return null;
}

/**
 * Parse + validate a translator response into a ToolCall. Returns null on
 * malformed JSON, the "none" sentinel, a missing name, or an unregistered name
 * (fail-soft — the caller falls back to today's behaviour).
 */
export function parseToolShimResponse(
  content: string,
  isRegistered: (name: string) => boolean,
): ToolCall | null {
  if (!content) return null;
  const jsonStr = extractFirstJsonObject(content);
  if (!jsonStr) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  if (obj[SENTINEL_NONE] === true) return null;

  const name = obj.name ?? obj.call ?? obj.function;
  if (typeof name !== 'string' || !name) return null;
  if (!isRegistered(name)) return null;

  const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? {};
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>)
    : {};

  return {
    id: `call_shim_${crypto.randomUUID()}`,
    name,
    arguments: args,
  };
}

/**
 * Translate prose into a valid tool call via the injected translator model.
 * Fail-soft: any failure (no tools, LLM error, malformed/none/unregistered
 * response) returns null so the caller keeps today's behaviour.
 */
export async function translateToToolCall(
  opts: TranslateToToolCallOptions,
): Promise<ToolCall | null> {
  const { text, tools, complete, isRegistered } = opts;
  if (!text?.trim() || tools.length === 0) return null;

  let content: string;
  const startedAt = Date.now();
  try {
    content = await complete(buildToolShimPrompt(text, tools));
  } catch (error) {
    // Translator call failed (timeout/5xx/etc). Fail-soft to current behaviour,
    // but at WARN with the elapsed time: a slow translator is invisible from the
    // outside (it burns wall-clock on a turn whose answer is already written)
    // and a `debug` breadcrumb is not enough to find it in a post-mortem.
    modelLogger.warn(
      { error, elapsedMs: Date.now() - startedAt },
      'tool-translation failed, skipping toolshim',
    );
    return null;
  }

  return parseToolShimResponse(content, isRegistered);
}

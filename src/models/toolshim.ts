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
  try {
    content = await complete(buildToolShimPrompt(text, tools));
  } catch (error) {
    // Translator call failed (timeout/5xx/etc). Fail-soft to current behaviour,
    // but leave a breadcrumb so the failure isn't fully silent — the caller's
    // success/unbound logs never fire on this thrown-error path.
    modelLogger.debug({ error }, 'tool-translation failed, skipping toolshim');
    return null;
  }

  return parseToolShimResponse(content, isRegistered);
}

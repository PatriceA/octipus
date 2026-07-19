/**
 * DeepSeek native-template leak detection and recovery.
 *
 * DeepSeek-v4-flash / v4-pro (and occasionally V3 reasoner) sometimes emit
 * their native tool-call markup as plain text in the `content` channel
 * instead of as structured `tool_calls`. Two known formats:
 *
 *   - DSML namespace (V4-flash/pro):
 *       <｜｜DSML｜｜tool_calls>
 *       <｜｜DSML｜｜invoke name="tool_name">
 *         <｜｜DSML｜｜parameter name="x" string="true">value</｜｜DSML｜｜parameter>
 *         <｜｜DSML｜｜parameter name="n" string="false">42</｜｜DSML｜｜parameter>
 *       </｜｜DSML｜｜invoke>
 *       </｜｜DSML｜｜tool_calls>
 *
 *   - V3 official SentencePiece (deepseek-reasoner, V3.x):
 *       <｜tool▁call▁begin｜>function<｜tool▁sep｜>tool_name
 *       ```json
 *       {"x": "value"}
 *       ```
 *       <｜tool▁call▁end｜>
 *
 * U+FF5C `｜` is the fullwidth pipe used as the fence; U+2581 `▁` is the
 * SentencePiece glyph used in the V3 separators. Some serializers emit
 * underscore in place of `▁` — accept both.
 *
 * Used by both the direct DeepSeek provider AND the LiteLLM proxy path —
 * the same leak shows up regardless of which provider sees the response.
 * Without recovery, throwing TOOL_CALL_INVALID just burns the retry budget
 * because the model stays stuck in the pattern.
 */

import type { ToolCall } from '@/core/types';
import { repairTruncatedJson } from '@/utils/json-repair';

/**
 * Cheap detector — true when the content channel contains native DeepSeek
 * tool-call markup that the model should have emitted as structured
 * tool_calls. Caller is expected to only consult this when the upstream
 * response has zero structured tool_calls.
 */
export const DEEPSEEK_TEMPLATE_LEAK =
  /<\/?｜+(?:DSML｜+(?:tool_calls?|tool_call|invoke|parameter|function|tool_outputs?)|tool[▁_]calls?[▁_]begin|tool[▁_]call[▁_]begin|tool[▁_]calls?[▁_]end|tool[▁_]sep|tool[▁_]outputs?[▁_]begin)\b/iu;

/** Detect DeepSeek thinking/reasoning variants by id (reasoner/r1/thinking/flash/v4). */
export function isDeepSeekReasoningModel(modelName: string): boolean {
  return /reasoner|r1|thinking|flash|v4/.test((modelName || '').toLowerCase());
}

/**
 * DeepSeek's thinking mode rejects a forced `tool_choice` with 400 "Thinking
 * mode does not support this tool_choice". Downgrade `required` → `auto` for
 * those models so structured-output/escalate paths don't hard-crash — the model
 * still gets the tools and usually calls them; callers already fall back to
 * prose-parsing when a forced call doesn't materialize. `auto`/`none` pass
 * through unchanged.
 */
export function coerceDeepseekToolChoice<T extends 'auto' | 'required' | 'none' | undefined>(
  model: string,
  toolChoice: T,
): T | 'auto' {
  return toolChoice === 'required' && isDeepSeekReasoningModel(model) ? 'auto' : toolChoice;
}

/** Parse DeepSeek native tool-call markup back into structured ToolCall objects. */
export function parseDsmlToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let idx = 0;

  const dsmlInvoke = /<｜+(?:DSML｜+)?invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜+(?:DSML｜+)?invoke>/giu;
  const dsmlParam = /<｜+(?:DSML｜+)?parameter\s+name="([^"]+)"(?:\s+string="(true|false)")?[^>]*>([\s\S]*?)<\/｜+(?:DSML｜+)?parameter>/giu;

  for (const m of content.matchAll(dsmlInvoke)) {
    const name = m[1];
    const inner = m[2];
    const args: Record<string, unknown> = {};
    for (const pm of inner.matchAll(dsmlParam)) {
      const pname = pm[1];
      const isString = pm[2] !== 'false';
      const raw = pm[3];
      args[pname] = isString ? raw : coerceParam(raw);
    }
    calls.push({ id: `dsml_${idx++}`, name, arguments: args });
  }

  const v3Call = /<｜tool[▁_]call[▁_]begin｜>\s*function\s*<｜tool[▁_]sep｜>([^\s<`]+)\s*```(?:json)?\s*([\s\S]*?)\s*```\s*<｜tool[▁_]call[▁_]end｜>/giu;
  for (const m of content.matchAll(v3Call)) {
    const name = m[1];
    const rawArgs = m[2];
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      const repaired = repairTruncatedJson(rawArgs);
      if (repaired) {
        try { args = JSON.parse(repaired) as Record<string, unknown>; } catch { /* keep empty */ }
      }
    }
    calls.push({ id: `v3_${idx++}`, name, arguments: args });
  }

  return calls;
}

/** Coerce a `string="false"` parameter value into number/bool/null/json. */
function coerceParam(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  try { return JSON.parse(t); } catch { return raw; }
}

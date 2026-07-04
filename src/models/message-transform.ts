import { createHash } from 'crypto';
import type { AgentMessage } from '@/core/types';

/**
 * Normalize tool call IDs across providers.
 * OpenAI IDs can be 450+ chars with pipe characters.
 * Anthropic limits to 64 chars, alphanumeric + hyphen/underscore.
 * Standardize to max 64 chars, alphanumeric + hyphen.
 *
 * Idempotent: a normalized id passes through unchanged. Round-trip
 * stable: the same input always produces the same output (hash for
 * long ids is deterministic).
 *
 * If stripping invalid chars leaves nothing (e.g. an id that was all
 * pipes / colons / dots), we fall back to the hash form so we never
 * return an empty string for a non-empty input — that would silently
 * drop the tool message link.
 */
export function normalizeToolCallId(id: string): string {
  if (!id) return id;
  // Strip non-alphanumeric except hyphens and underscores
  const cleaned = id.replace(/[^a-zA-Z0-9-_]/g, '');
  if (cleaned.length === 0) {
    // All-invalid input — hash so we still produce a stable, non-empty id.
    return 'tc-' + createHash('sha256').update(id).digest('hex').slice(0, 60);
  }
  if (cleaned.length <= 64) return cleaned;
  // Hash long IDs to fit
  return 'tc-' + createHash('sha256').update(id).digest('hex').slice(0, 60);
}

/**
 * Track original -> normalized ID mappings for a message sequence.
 */
export function buildIdMap(messages: AgentMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id) {
          const normalized = normalizeToolCallId(tc.id);
          if (normalized !== tc.id) map.set(tc.id, normalized);
        }
      }
    }
  }
  return map;
}

/**
 * Enforce the OpenAI tool-call <-> tool-message pairing invariant in BOTH
 * directions (hoisted from litellm-client so every direct provider path gets
 * it, not just the proxy — A10):
 *   (a) Drop tool messages whose tool_call_id has no matching assistant
 *       tool_calls entry (lenient providers accept; strict ones 400).
 *   (b) For every assistant `tool_calls` id missing a following `tool`
 *       message, synthesize a placeholder. Prevents DeepSeek's 400
 *       "insufficient tool messages following tool_calls message" after
 *       compaction, history re-slices, or bailed-out agent loops.
 */
export function sanitizeToolMessages(messages: AgentMessage[]): AgentMessage[] {
  const validToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) validToolCallIds.add(tc.id);
    }
  }
  const filtered = messages.filter((msg) => {
    if (msg.role !== 'tool') return true;
    return msg.toolCallId != null && validToolCallIds.has(msg.toolCallId);
  });

  const out: AgentMessage[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const msg = filtered[i];
    out.push(msg);
    if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue;

    const expected = new Map(msg.toolCalls.map((tc) => [tc.id, tc.name] as const));
    let j = i + 1;
    const seen = new Set<string>();
    while (j < filtered.length && filtered[j].role === 'tool') {
      const id = filtered[j].toolCallId;
      if (id != null && expected.has(id)) seen.add(id);
      out.push(filtered[j]);
      j++;
    }
    for (const [id, name] of expected) {
      if (!seen.has(id)) {
        out.push({
          role: 'tool',
          content: '[no result recorded — tool response missing from history]',
          toolCallId: id,
          name,
          timestamp: new Date(),
        });
      }
    }
    i = j - 1;
  }
  return out;
}

/**
 * Transform messages for cross-model compatibility.
 * - Normalizes tool call IDs
 * - Strips provider-specific thinking blocks (all providers)
 * - Enforces tool-call/tool-message pairing (A10)
 */
export function transformMessagesForProvider(
  messages: AgentMessage[],
  _targetProvider: string,
): AgentMessage[] {
  const idMap = buildIdMap(messages);

  // idMap normalization is only needed when there are long/invalid ids; the
  // thinking-strip and pairing passes must run for ALL providers regardless.
  const mapped = messages.map((msg) => {
    const transformed = { ...msg };

    if (transformed.role === 'assistant' && transformed.toolCalls) {
      transformed.toolCalls = transformed.toolCalls.map((tc) => ({
        ...tc,
        id: idMap.get(tc.id) || normalizeToolCallId(tc.id),
      }));
    }

    if (transformed.role === 'tool' && transformed.toolCallId) {
      const original = transformed.toolCallId;
      transformed.toolCallId = idMap.get(original) || normalizeToolCallId(original);
    }

    // Strip thinking blocks — <thinking>, <think>, <reasoning> variants.
    if (transformed.role === 'assistant' && typeof transformed.content === 'string') {
      transformed.content = transformed.content
        .replace(/<(?:think|thinking|reasoning)>[\s\S]*?<\/(?:think|thinking|reasoning)>/g, '')
        .trim();
    }

    return transformed;
  });

  return sanitizeToolMessages(mapped);
}

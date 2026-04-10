import { createHash } from 'crypto';
import type { AgentMessage } from '@/core/types';

/**
 * Normalize tool call IDs across providers.
 * OpenAI IDs can be 450+ chars with pipe characters.
 * Anthropic limits to 64 chars.
 * Standardize to max 64 chars, alphanumeric + hyphen.
 */
export function normalizeToolCallId(id: string): string {
  if (!id) return id;
  // Strip non-alphanumeric except hyphens and underscores
  const cleaned = id.replace(/[^a-zA-Z0-9-_]/g, '');
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
 * Transform messages for cross-model compatibility.
 * - Normalizes tool call IDs
 * - Strips provider-specific thinking blocks
 * - Ensures tool results reference valid tool call IDs
 */
export function transformMessagesForProvider(
  messages: AgentMessage[],
  targetProvider: string,
): AgentMessage[] {
  const idMap = buildIdMap(messages);
  if (idMap.size === 0 && targetProvider !== 'anthropic') return messages;

  return messages.map((msg) => {
    const transformed = { ...msg };

    // Normalize tool call IDs in assistant messages
    if (transformed.role === 'assistant' && transformed.toolCalls) {
      transformed.toolCalls = transformed.toolCalls.map((tc) => ({
        ...tc,
        id: idMap.get(tc.id) || normalizeToolCallId(tc.id),
      }));
    }

    // Normalize tool_call_id in tool result messages
    if (transformed.role === 'tool' && transformed.toolCallId) {
      const original = transformed.toolCallId;
      transformed.toolCallId = idMap.get(original) || normalizeToolCallId(original);
    }

    // Strip thinking blocks for non-supporting providers
    if (transformed.role === 'assistant' && typeof transformed.content === 'string') {
      // Remove <thinking>...</thinking> blocks
      transformed.content = transformed.content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
    }

    return transformed;
  });
}

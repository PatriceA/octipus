import { isAnthropicFamily } from '@/models/providers/prompt-cache';

/**
 * `messages` without provider-signed reasoning from index `from` on.
 *
 * Claude's thinking blocks are bound to the exact conversation in front of
 * them (Anthropic "preserved thinking": the system prompt, the tool set and
 * every earlier message). Replayed after Octipus edited an earlier turn — a
 * truncated tool output, a summary, a trimmed head, a changed tool list —
 * they no longer match: the API rejects the request (accounts created on or
 * after 2026-08-31, on every Claude model that runs the check) or drops the
 * blocks, and the prompt cache with them. Removing every signed block from
 * the first edited message on keeps the request valid whatever the model:
 * the earlier blocks still match, and no later one is left to check.
 *
 * Only Claude's reasoning is bound this way — native content blocks, and the
 * `reasoning_details` OpenRouter relays for a Claude model. Gemini thought
 * signatures and DeepSeek reasoning must keep travelling with their tool
 * calls, so they stay.
 */
export function stripSignedReasoning<T extends { providerRaw?: Record<string, unknown> }>(messages: T[], from = 0): T[] {
  let changed = false;
  const out = messages.map((message, index) => {
    if (index < from || !message.providerRaw) return message;
    const raw = withoutSignedReasoning(message.providerRaw);
    if (raw === message.providerRaw) return message;
    changed = true;
    return { ...message, providerRaw: raw };
  });
  return changed ? out : messages;
}

function withoutSignedReasoning(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  let next: Record<string, unknown> = raw;
  if (Array.isArray(raw.anthropicContent)) {
    const blocks = (raw.anthropicContent as Array<{ type?: unknown }>)
      .filter((block) => block?.type !== 'thinking' && block?.type !== 'redacted_thinking');
    if (blocks.length !== raw.anthropicContent.length) {
      const { anthropicContent: _signed, ...rest } = next;
      next = blocks.length ? { ...rest, anthropicContent: blocks } : rest;
    }
  }
  if (typeof raw.openrouterModel === 'string' && isAnthropicFamily(raw.openrouterModel)
    && (raw.reasoning_details !== undefined || raw.reasoning !== undefined)) {
    const { reasoning_details: _details, reasoning: _reasoning, ...rest } = next;
    next = rest;
  }
  if (next === raw) return raw;
  return Object.keys(next).some((key) => key !== 'openrouterModel') ? next : undefined;
}

import type { AgentMessage } from '@/core/types';

/**
 * Gemini history hygiene, shared by GeminiProvider (OpenAI-compat) and
 * CustomGeminiCompatProvider (native envelope) so both wires get identical
 * repair semantics (pi's approach — google-shared.ts / transform-messages.ts):
 *
 *  - Synthesize `call_${index}` ids for tool calls with empty ids (empty ids
 *    otherwise cause the whole round to be stripped → the model repeats it).
 *    When ids are synthesized we drop providerRaw (its embedded ids no longer
 *    match the synthesized tool_call_ids), so the formatter reconstructs.
 *  - Repair orphaned tool calls with a synthetic "No result provided" error
 *    result instead of dropping the whole round (G1 — never resend a call
 *    whose response was dropped).
 *  - Filter empty-content messages (empty assistant/user turns) — Gemini
 *    rejects empty parts.
 *  - Drop orphan tool responses that have no preceding tool-call turn.
 *  - Inject a synthetic user turn when a tool-call turn would otherwise follow
 *    a non user/tool turn (Gemini requires it).
 */
export function sanitizeGeminiHistory(messages: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      let idsSynthesized = false;
      const calls = msg.toolCalls.map((tc, idx) => {
        if (tc.id && tc.id.trim()) return tc;
        idsSynthesized = true;
        return { ...tc, id: `call_${idx}` };
      });

      // Gather the immediately-following tool responses.
      const responses: AgentMessage[] = [];
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        responses.push(messages[j]);
        j++;
      }
      const byId = new Map<string, AgentMessage>();
      responses.forEach((r, idx) => {
        const key = r.toolCallId && r.toolCallId.trim() ? r.toolCallId : `call_${idx}`;
        byId.set(key, r);
      });

      // Gemini: a function_call turn must follow a user or function_response
      // turn. Inject a synthetic user turn if the prev emitted one isn't.
      const prev = out[out.length - 1];
      if (!(prev && (prev.role === 'user' || prev.role === 'tool'))) {
        out.push({ role: 'user', content: '(continuing)', timestamp: new Date() });
      }

      out.push(
        idsSynthesized
          ? { ...msg, toolCalls: calls, providerRaw: undefined }
          : { ...msg, toolCalls: calls },
      );

      for (const tc of calls) {
        const resp = byId.get(tc.id);
        out.push(
          resp
            // Re-key the response to the (possibly synthesized) call id so the
            // pairing holds on the wire.
            ? { ...resp, toolCallId: tc.id }
            : {
                role: 'tool',
                content: 'No result provided',
                toolCallId: tc.id,
                name: tc.name,
                timestamp: new Date(),
              },
        );
      }
      i = j - 1;
      continue;
    }

    // Orphan tool response — no preceding tool_calls turn.
    if (msg.role === 'tool') continue;

    // Filter empty-content turns (thinking-only / errored partial assistant
    // turns, empty user/system turns).
    if (!msg.content || !String(msg.content).trim()) continue;

    out.push(msg);
  }

  return out;
}

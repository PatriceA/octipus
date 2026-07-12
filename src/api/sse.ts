/**
 * Server-Sent Events helpers (WS6 — OpenAI-compatible streaming).
 *
 * Elysia streams a response when the handler returns an async generator; each
 * yielded string is flushed as a chunk. These helpers format OpenAI-style SSE
 * frames (`data: {json}\n\n`, terminated by `data: [DONE]\n\n`) so the official
 * `openai` SDK's streaming client parses them correctly.
 *
 * Step 1 (this file) chunks the *final* assistant text — correct protocol, not
 * token-true. Token-true streaming (bridging the run's gateway event deltas)
 * is a later step and can reuse `sseData`/`sseDone` unchanged.
 */

/** Headers a caller should set on the response for a well-formed SSE stream. */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Defeat proxy buffering (nginx) so chunks reach the client promptly.
  'X-Accel-Buffering': 'no',
};

/** Format one SSE data frame carrying a JSON payload. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** The terminal frame every OpenAI-compatible stream must end with. */
export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

/**
 * Split text into ~`size`-char slices for streaming. Never returns an empty
 * array for non-empty input, so a stream always emits at least one content
 * chunk before `[DONE]`.
 */
export function chunkText(text: string, size = 48): string[] {
  if (text.length === 0) return [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

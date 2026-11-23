/**
 * Token-true streaming for `/v1/chat/completions` passthrough (a registry
 * model id): the provider's `stream()` deltas go out as `chat.completion.chunk`
 * frames while the model is still producing them.
 *
 * The streamed text must concatenate to exactly the `message.content` the same
 * request returns without `stream`, and SSE cannot take text back. So this
 * runs only for a provider whose stream is its completion
 * (`ModelProvider.streamIsComplete`: neither path filters, trims or rewrites
 * the text), and forwards each content delta unaltered. Every other provider
 * normalises its streamed and completed text differently (thinking tags,
 * trimming, JSON-thinking strip): the route completes it and chunks the
 * finished text, as before.
 *
 * Tool-call deltas are not answer text and are never sent. Usage is not sent:
 * the endpoint does not take `stream_options`.
 */
import { sseData, sseDone } from '@/api/sse';
import type { StreamChunk } from '@/models/litellm-client';
import { apiLogger } from '@/utils/logger';

/** One streaming chunk in the `chat.completion.chunk` shape. */
export function toChunk(id: string, model: string, created: number, delta: Record<string, unknown>, finish: string | null) {
  return {
    id,
    object: 'chat.completion.chunk' as const,
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** How long a reply whose client left after its last text keeps reading, for the provider's usage chunk. */
export const USAGE_DRAIN_MS = 2_000;

export interface PassthroughStream {
  id: string;
  model: string;
  /** The provider stream, already advanced once: `first` is its first result. */
  chunks: AsyncGenerator<StreamChunk>;
  first: IteratorResult<StreamChunk>;
  /** The provider call's abort, separate from the client's. */
  provider: AbortController;
  /** The client's request signal. */
  client: AbortSignal;
  /** How long a frame may wait for the client to read it. */
  stallTimeoutMs: number;
}

/**
 * SSE frames for a passthrough stream: the role chunk, content deltas as they
 * arrive, the finish chunk and `[DONE]`. Pulled one frame at a time by the
 * response body, so the provider is read only as fast as the client reads, and
 * nothing is buffered beyond the frame in hand.
 *
 * Ends cleanly every way a stream can end:
 *   - the client leaves mid-reply: the provider call is aborted at once;
 *   - the client leaves once the reply's text is complete: the provider is
 *     read on, for up to `USAGE_DRAIN_MS`, so its usage chunk (sent after the
 *     finish reason) reaches the accounting and the call is not billed blind;
 *   - the client stops reading but stays connected: after `stallTimeoutMs`
 *     the provider call is dropped and its rate-limit slot released;
 *   - the provider fails midway: an OpenAI error frame, then `[DONE]`.
 */
export async function* passthroughSse(s: PassthroughStream): AsyncGenerator<string> {
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta: Record<string, unknown>, finish: string | null = null) => sseData(toChunk(s.id, s.model, created, delta, finish));
  let finished = false; // the provider sent its finish reason: the text is complete
  let done = false;
  let stalled = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  const onClientGone = () => {
    if (!finished) { s.provider.abort(s.client.reason); return; }
    drainTimer = setTimeout(() => s.provider.abort(s.client.reason), USAGE_DRAIN_MS);
  };
  if (s.client.aborted) onClientGone();
  else s.client.addEventListener('abort', onClientGone, { once: true });

  // Every frame waits for the client under the stall timer.
  async function* emit(text: string): AsyncGenerator<string> {
    const timer = setTimeout(() => {
      stalled = true;
      apiLogger.warn({ model: s.model, stallTimeoutMs: s.stallTimeoutMs }, '/v1/chat/completions stream stalled: the client stopped reading — dropping the provider call');
      s.provider.abort(new Error('client stopped reading'));
      // The provider stream is parked at its own yield: returning it releases its rate-limit slot now.
      void s.chunks.return(undefined);
    }, s.stallTimeoutMs);
    try {
      yield text;
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    yield* emit(frame({ role: 'assistant' }));
    for (let next = s.first; !next.done; next = await s.chunks.next()) {
      if (next.value.finishReason) finished = true;
      if (next.value.content) yield* emit(frame({ content: next.value.content }));
      if (stalled) return;
    }
    done = true;
    yield* emit(frame({}, 'stop'));
    yield* emit(sseDone());
  } catch (err) {
    if (s.client.aborted || stalled) {
      apiLogger.info({ model: s.model, stalled }, '/v1/chat/completions stream ended without its client');
      return;
    }
    apiLogger.error({ err, model: s.model }, '/v1/chat/completions stream failed after it started');
    yield* emit(sseData({ error: { message: (err as Error)?.message || 'Internal error', type: 'server_error', param: null, code: null } }));
    yield* emit(sseDone());
  } finally {
    s.client.removeEventListener('abort', onClientGone);
    try {
      // The client left after the text was complete: read the usage chunk, within the drain bound.
      if (finished && !done && !stalled) {
        drainTimer ??= setTimeout(() => s.provider.abort(new Error('usage drain bound reached')), USAGE_DRAIN_MS);
        await drain(s.chunks);
      }
    } finally {
      clearTimeout(drainTimer);
      await s.chunks.return(undefined);
      s.provider.abort();
    }
  }
}

async function drain(chunks: AsyncGenerator<StreamChunk>): Promise<void> {
  try {
    while (!(await chunks.next()).done) { /* accounting reads the chunks */ }
  } catch (err) {
    apiLogger.info({ err }, '/v1/chat/completions: provider stream not drained before its bound');
  }
}

/**
 * Token-true streaming for `/v1/chat/completions` passthrough (a registry
 * model id): the provider's `stream()` deltas go out as `chat.completion.chunk`
 * frames while the model is still producing them.
 *
 * The streamed text must concatenate to exactly the answer the request ends
 * with, and SSE cannot take text back. The answer is the provider stream after
 * `collectStream`'s normalisation (the same one the root agent's streamed calls
 * get), so text is sent only once that normalisation can no longer change it:
 *
 *   - leading whitespace waits for the first visible character (a reply of
 *     whitespace only normalises to nothing);
 *   - a reply whose first visible character is `{` is held whole: it may be a
 *     leaked `{"thought": …}` wrapper the normaliser strips;
 *   - from the first `｜` (DeepSeek tool-template markup) on, the rest is held.
 *
 * At the end the held text is sent. If the normalised answer does not begin
 * with what was already sent (DeepSeek markup after visible text, which the
 * normaliser turns into tool calls or an error), the stream ends with an error
 * frame instead of a finish chunk: a client gets a failure, never a wrong answer.
 *
 * Tool-call deltas are not answer text and are never sent. Usage is not sent:
 * the endpoint does not take `stream_options`.
 */
import { chunkText, sseData, sseDone } from '@/api/sse';
import type { CompletionOptions, StreamChunk } from '@/models/litellm-client';
import { collectStream } from '@/models/stream-collect';
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

/** Decides which streamed text is already final (see the module comment). */
export class AnswerReleaseGate {
  private held = '';
  private sent = '';
  private mode: 'leading' | 'open' | 'held' = 'leading';

  /** Takes a provider delta; returns the text that may go to the client now. */
  push(delta: string): string {
    if (this.mode === 'held') {
      this.held += delta;
      return '';
    }
    let text = delta;
    if (this.mode === 'leading') {
      this.held += delta;
      const visible = this.held.trimStart();
      if (!visible) return '';
      if (visible.startsWith('{')) {
        this.mode = 'held';
        return '';
      }
      this.mode = 'open';
      text = this.held;
      this.held = '';
    }
    if (text.includes('｜')) {
      this.mode = 'held';
      this.held += text;
      return '';
    }
    this.sent += text;
    return text;
  }

  /** What is left to send of `answer`, or null when `answer` does not continue the text already sent. */
  rest(answer: string): string | null {
    return answer.startsWith(this.sent) ? answer.slice(this.sent.length) : null;
  }
}

async function* replay(chunks: StreamChunk[]): AsyncGenerator<StreamChunk> {
  yield* chunks;
}

function errorFrame(message: string) {
  return sseData({ error: { message, type: 'server_error', param: null, code: null } });
}

export interface PassthroughStream {
  id: string;
  model: string;
  /** The provider stream, already advanced once: `first` is its first result. */
  chunks: AsyncGenerator<StreamChunk>;
  first: IteratorResult<StreamChunk>;
  options: CompletionOptions;
  /** True once the client has gone; nothing more is sent then. */
  aborted: () => boolean;
  /** Releases what the request holds (its abort listener); called once, at the end. */
  release: () => void;
}

/**
 * SSE frames for a passthrough stream: the role chunk, content deltas as the
 * gate releases them, the held rest, the finish chunk and `[DONE]`. Pulled one
 * frame at a time by the response body, so the provider is read only as fast
 * as the client reads; memory is the chunks of this one answer, as for a
 * non-streamed completion.
 */
export async function* passthroughSse(s: PassthroughStream): AsyncGenerator<string> {
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta: Record<string, unknown>, finish: string | null = null) => sseData(toChunk(s.id, s.model, created, delta, finish));
  try {
    yield frame({ role: 'assistant' });
    const seen: StreamChunk[] = [];
    const gate = new AnswerReleaseGate();
    for (let next = s.first; !next.done; next = await s.chunks.next()) {
      seen.push(next.value);
      const text = next.value.content ? gate.push(next.value.content) : '';
      if (text) yield frame({ content: text });
    }
    const answer = (await collectStream(replay(seen), s.options, s.model)).content;
    const rest = gate.rest(answer);
    if (rest === null) {
      apiLogger.error({ model: s.model }, '/v1/chat/completions: the normalised answer does not continue the streamed text — ending the stream with an error');
      yield errorFrame('The provider\'s reply changed after it began streaming; retry without `stream`.');
      yield sseDone();
      return;
    }
    for (const piece of chunkText(rest)) yield frame({ content: piece });
    yield frame({}, 'stop');
    yield sseDone();
  } catch (err) {
    if (s.aborted()) {
      apiLogger.info({ model: s.model }, '/v1/chat/completions stream closed by the client');
      return;
    }
    apiLogger.error({ err, model: s.model }, '/v1/chat/completions stream failed after it started');
    yield errorFrame((err as Error)?.message || 'Internal error');
    yield sseDone();
  } finally {
    try {
      await s.chunks.return(undefined);
    } finally {
      s.release();
    }
  }
}

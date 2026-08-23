import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { SSE_HEADERS, chunkText, sseData, sseDone } from '@/api/sse';
import { getOrchestratorService } from '@/core/orchestrator';
import type { AgentMessage } from '@/core/types';
import { getModelRegistry } from '@/models/model-registry';
import { getProviderRouter } from '@/models/providers';
import { isAuthenticated, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { generateId } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';

/**
 * OpenAI-compatible HTTP API (WS6) — mounted at `/v1`, alongside `/api`.
 *
 * Lets off-the-shelf OpenAI SDKs talk to Octipus. Two request modes:
 *
 *   - `octipus/orchestrator` (the default when no model is given) routes the
 *     conversation's latest user message through the full classify→route
 *     orchestrator pipeline. This mode is **session-stateful**: pass a stable
 *     `user` field (or `X-Octipus-Session` header) to keep a conversation
 *     sticky; otherwise each call runs in a fresh ephemeral session.
 *   - a raw registry **model id** (e.g. `gpt-4o`, `llama3.2`) is a single-turn
 *     **passthrough** straight to that provider — no tools, no session. This is
 *     the mode that honors OpenAI's stateless `messages`-array semantics
 *     exactly, for callers who just want Octipus as a keyed gateway.
 *
 * Auth: the same Bearer `octi_…` tokens / browser sessions as `/api` (the
 * app-level `.derive()` + `authGuard` cover `/v1` too). The `api:chat` scope is
 * enforced on completions. Errors use the OpenAI error envelope so SDKs behave.
 *
 * Streaming (`stream: true`) is protocol-correct SSE that chunks the *final*
 * text (WS6 step 1). Token-true streaming is a later step; see `src/api/sse.ts`.
 */

const ORCHESTRATOR_MODEL = 'octipus/orchestrator';

/** OpenAI error envelope. Returns the body; caller sets `set.status`. */
function oaiError(
  message: string,
  type: 'invalid_request_error' | 'authentication_error' | 'rate_limit_exceeded' | 'server_error',
  code: string | null = null,
) {
  return { error: { message, type, param: null, code } };
}

/** Unix seconds — OpenAI `created` field. */
function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

interface OaiMessage {
  role: string;
  content: string;
}

/** The last user turn — the message the orchestrator acts on. */
function lastUserMessage(messages: OaiMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return undefined;
}

function toChatCompletion(
  id: string,
  model: string,
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
) {
  return {
    id,
    object: 'chat.completion' as const,
    created: nowUnix(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content },
        finish_reason: 'stop' as const,
      },
    ],
    usage,
  };
}

/** One streaming chunk in the `chat.completion.chunk` shape. */
function toChunk(id: string, model: string, created: number, delta: Record<string, unknown>, finish: string | null) {
  return {
    id,
    object: 'chat.completion.chunk' as const,
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/** Stream the final `content` as protocol-correct SSE chunks. */
async function* streamCompletion(id: string, model: string, content: string) {
  const created = nowUnix();
  yield sseData(toChunk(id, model, created, { role: 'assistant' }, null));
  for (const piece of chunkText(content)) {
    yield sseData(toChunk(id, model, created, { content: piece }, null));
  }
  yield sseData(toChunk(id, model, created, {}, 'stop'));
  yield sseDone();
}

export const openaiCompatRoutes = new Elysia()
  .use(apiContext)

  // Shape every error this surface can throw into the OpenAI error envelope so
  // off-the-shelf SDK error handling works. Handlers return their own envelopes
  // for expected cases; this catches body-schema VALIDATION (thrown by Elysia
  // before the handler runs) and any unexpected throw.
  .onError(({ code, error, set }) => {
    if (code === 'NOT_FOUND') return; // let the router's default 404 stand
    if (code === 'VALIDATION') {
      set.status = 400;
      return oaiError((error as Error).message || 'Invalid request body', 'invalid_request_error');
    }
    set.status = 500;
    return oaiError((error as Error)?.message || 'Internal error', 'server_error');
  })

  // GET /v1/models — registry models + the virtual orchestrator model.
  .get('/models', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return oaiError('Authentication required', 'authentication_error');
    }
    const created = nowUnix();
    const data: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = [
      { id: ORCHESTRATOR_MODEL, object: 'model', created, owned_by: 'octipus' },
    ];
    try {
      const models = await getModelRegistry().getAllModels();
      for (const m of models) {
        data.push({ id: m.name, object: 'model', created, owned_by: m.provider });
      }
    } catch (err) {
      apiLogger.warn({ err }, '/v1/models: registry listing failed; returning orchestrator only');
    }
    return { object: 'list', data };
  })

  // POST /v1/chat/completions — orchestrator route or provider passthrough.
  .post(
    '/chat/completions',
    async ({ user, principal, body, set, request }) => {
      if (!user || !isAuthenticated(principal)) {
        set.status = 401;
        return oaiError('Authentication required', 'authentication_error');
      }
      if (!requireScope(principal, API_SCOPES.CHAT)) {
        set.status = 403;
        return oaiError(`API token missing required scope "${API_SCOPES.CHAT}"`, 'authentication_error', 'insufficient_scope');
      }

      const model = body.model?.trim() || ORCHESTRATOR_MODEL;
      const messages = body.messages as OaiMessage[];
      if (!Array.isArray(messages) || messages.length === 0) {
        set.status = 400;
        return oaiError('`messages` must be a non-empty array', 'invalid_request_error', 'messages');
      }

      // Reject octipus/<something-other-than-orchestrator> explicitly rather
      // than silently treating it as a passthrough model id that won't resolve.
      if (model.startsWith('octipus/') && model !== ORCHESTRATOR_MODEL) {
        set.status = 400;
        return oaiError(
          `Unknown Octipus model "${model}". Use "${ORCHESTRATOR_MODEL}" or a registry model id (see GET /v1/models).`,
          'invalid_request_error',
          'model_not_found',
        );
      }

      const id = `chatcmpl-${generateId()}`;
      const wantStream = body.stream === true;

      try {
        if (model === ORCHESTRATOR_MODEL) {
          // ── Orchestrator mode (session-stateful) ───────────────────────
          const prompt = lastUserMessage(messages);
          if (!prompt) {
            set.status = 400;
            return oaiError('No user message found in `messages`', 'invalid_request_error', 'messages');
          }
          // Sticky session via `user` field or X-Octipus-Session header;
          // otherwise a fresh ephemeral session id per request.
          const sticky = request.headers.get('x-octipus-session') || body.user;
          const sessionId = sticky || `oai-${generateId()}`;

          const result = await getOrchestratorService().handleMessage(
            sessionId,
            user.id,
            prompt,
            'api',
          );
          const content = result.response;
          // The orchestrator exposes only a total token count; report it as
          // total (and completion) with prompt unknown. Passthrough mode below
          // reports the provider's exact split.
          const total = result.metadata?.tokens ?? 0;
          const usage = { prompt_tokens: 0, completion_tokens: total, total_tokens: total };

          if (wantStream) {
            set.headers = { ...set.headers, ...SSE_HEADERS };
            return streamCompletion(id, model, content);
          }
          return toChatCompletion(id, model, content, usage);
        }

        // ── Passthrough mode (stateless, single-turn, no tools) ───────────
        const now = new Date();
        const agentMessages: AgentMessage[] = messages.map((m) => ({
          role: (['system', 'user', 'assistant', 'tool'].includes(m.role) ? m.role : 'user') as AgentMessage['role'],
          content: m.content,
          timestamp: now,
        }));

        const result = await getProviderRouter().complete({
          model,
          messages: agentMessages,
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          topP: body.top_p,
          stopSequences: normalizeStop(body.stop),
          userId: user.id,
        });

        const usage = {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.totalTokens,
        };

        if (wantStream) {
          set.headers = { ...set.headers, ...SSE_HEADERS };
          return streamCompletion(id, result.model || model, result.content);
        }
        return toChatCompletion(id, result.model || model, result.content, usage);
      } catch (err) {
        const message = (err as Error).message || 'Internal error';
        // Unknown model / provider-resolution failures → 400 model_not_found;
        // everything else → 500 server_error.
        if (/no provider|unknown model|not found|no model/i.test(message)) {
          set.status = 400;
          return oaiError(message, 'invalid_request_error', 'model_not_found');
        }
        apiLogger.error({ err, model }, '/v1/chat/completions failed');
        set.status = 500;
        return oaiError(message, 'server_error');
      }
    },
    {
      body: t.Object({
        model: t.Optional(t.String()),
        messages: t.Array(
          t.Object({
            role: t.String(),
            content: t.String(),
          }),
          { minItems: 1 },
        ),
        stream: t.Optional(t.Boolean()),
        temperature: t.Optional(t.Number()),
        max_tokens: t.Optional(t.Number()),
        top_p: t.Optional(t.Number()),
        stop: t.Optional(t.Union([t.String(), t.Array(t.String())])),
        // Sticky-session hint (OpenAI's `user` field, reused).
        user: t.Optional(t.String()),
      }),
      detail: { tags: ['openai-compat'] },
    },
  );

/** Normalize OpenAI `stop` (string | string[] | undefined) to string[] | undefined. */
function normalizeStop(stop: string | string[] | undefined): string[] | undefined {
  if (stop === undefined) return undefined;
  return Array.isArray(stop) ? stop : [stop];
}

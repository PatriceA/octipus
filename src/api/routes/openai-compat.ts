import { budgetErrorBody } from '@/api/budget-error';
import { isSessionTurnCancelled } from '@/core/session-turn-lock';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { SSE_HEADERS, chunkText, sseData, sseDone } from '@/api/sse';
import { passthroughSse, toChunk } from '@/api/openai-token-stream';
import { getConfig } from '@/config';
import { getAgentService } from '@/core/agent';
import type { AgentMessage } from '@/core/types';
import type { CompletionOptions, StreamChunk } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { isRegisteredModel, resolveModel } from '@/models/resolve-model';
import { getProviderRouter } from '@/models/providers';
import { isAuthenticated, requireScope } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';
import { generateId } from '@/utils/crypto';
import { apiLogger } from '@/utils/logger';
import { inlineUiFallbackTextResolved } from '@/core/inline-ui/fallback';

/**
 * OpenAI-compatible HTTP API (WS6) — mounted at `/v1`, alongside `/api`.
 *
 * Lets off-the-shelf OpenAI SDKs talk to Octipus. Two request modes:
 *
 *   - `octipus/agent` (the default when no model is given) runs the
 *     conversation's latest user message through the full agent turn — the root
 *     agent with its tools, which delegates to specialists when it needs one.
 *     The former id `octipus/root agent` is still accepted, because it is
 *     configured in other people's clients. This mode is
 *     **session-stateful**: pass a stable
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
 * Streaming (`stream: true`): passthrough streams token-true from the
 * provider's `stream()` when that stream is its completion
 * (`ModelProvider.streamIsComplete`, `src/api/openai-token-stream.ts`), and
 * chunks the completed text otherwise. Agent mode chunks
 * the turn's *final* text: the turn rewrites its answer after the model has
 * written it (the output guard's whole-text verdict, inline-UI markers, relay
 * and scaffolding passes), and SSE cannot take streamed text back.
 */

/**
 * The virtual model id that means "route this through Octipus itself" rather
 * than straight at a registry model. `octipus/root agent` was its name until
 * the routing hop was deleted; it stays accepted because it is configured in
 * other people's OpenAI clients, where a rename we make is an outage they get.
 */
const AGENT_MODEL = 'octipus/agent';
// The retired id, frozen. A rename sweep already rewrote this literal once —
// which turns the compatibility alias into a 400 for exactly the clients it
// exists to keep working. It is a wire value, not an identifier.
const AGENT_MODEL_ALIASES = new Set([AGENT_MODEL, 'octipus/orchestrator']);

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

/** The last user turn — the message the root agent acts on. */
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
    const budget = budgetErrorBody(error);
    if (budget) { set.status = 429; return oaiError(budget.error, 'rate_limit_exceeded', budget.code); }
    if (code === 'NOT_FOUND') return; // let the router's default 404 stand
    if (code === 'VALIDATION') {
      set.status = 400;
      return oaiError((error as Error).message || 'Invalid request body', 'invalid_request_error');
    }
    set.status = 500;
    return oaiError((error as Error)?.message || 'Internal error', 'server_error');
  })

  // GET /v1/models — registry models + the virtual agent model.
  .get('/models', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) {
      set.status = 401;
      return oaiError('Authentication required', 'authentication_error');
    }
    const created = nowUnix();
    const data: Array<{ id: string; object: 'model'; created: number; owned_by: string }> = [
      { id: AGENT_MODEL, object: 'model', created, owned_by: 'octipus' },
    ];
    try {
      // The caller's models: install/org rows they may use plus their own
      // personal rows (coworking spec §8.1).
      const models = (await getModelRegistry().getModelsForUser(user.id)).filter((m) => m.isEnabled);
      for (const m of models) {
        data.push({ id: m.name, object: 'model', created, owned_by: m.provider });
      }
    } catch (err) {
      apiLogger.warn({ err }, '/v1/models: registry listing failed; returning the agent model only');
    }
    return { object: 'list', data };
  })

  // POST /v1/chat/completions — agent route or provider passthrough.
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

      const model = body.model?.trim() || AGENT_MODEL;
      const messages = body.messages as OaiMessage[];
      if (!Array.isArray(messages) || messages.length === 0) {
        set.status = 400;
        return oaiError('`messages` must be a non-empty array', 'invalid_request_error', 'messages');
      }

      // Reject octipus/<anything-else> explicitly rather than silently
      // treating it as a passthrough model id that won't resolve.
      if (model.startsWith('octipus/') && !AGENT_MODEL_ALIASES.has(model)) {
        set.status = 400;
        return oaiError(
          `Unknown Octipus model "${model}". Use "${AGENT_MODEL}" or a registry model id (see GET /v1/models).`,
          'invalid_request_error',
          'model_not_found',
        );
      }

      const id = `chatcmpl-${generateId()}`;
      const wantStream = body.stream === true;

      try {
        if (AGENT_MODEL_ALIASES.has(model)) {
          // ── Agent mode (session-stateful) ──────────────────────────────
          const prompt = lastUserMessage(messages);
          if (!prompt) {
            set.status = 400;
            return oaiError('No user message found in `messages`', 'invalid_request_error', 'messages');
          }
          // Sticky session via `user` field or X-Octipus-Session header;
          // otherwise a fresh ephemeral session id per request.
          const sticky = request.headers.get('x-octipus-session') || body.user;
          const sessionId = sticky || `oai-${generateId()}`;

          const result = await getAgentService().handleMessage(
            sessionId,
            user.id,
            prompt,
            'api',
          );
          // Interactive answers render only in the web app: a view as text, an HTML block as a plain line.
          const content = await inlineUiFallbackTextResolved(result.response, result.sessionId ?? sessionId);
          // The root agent exposes only a total token count; report it as
          // total (and completion) with prompt unknown. Passthrough mode below
          // reports the provider's exact split.
          const total = result.metadata?.tokens ?? 0;
          const usage = { prompt_tokens: 0, completion_tokens: total, total_tokens: total };

          if (wantStream) {
            Object.assign(set.headers, SSE_HEADERS);
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

        // An explicit model resolves only to a row this caller may use
        // (§8.2); a registered row they may not see is "not found", never a
        // raw id passed through.
        const row = await resolveModel({ userId: user.id, name: model });
        if (!row && await isRegisteredModel(model, user.id)) {
          set.status = 400;
          return oaiError(`Unknown model "${model}"`, 'invalid_request_error', 'model_not_found');
        }
        const options: CompletionOptions = {
          model: row?.modelId ?? model,
          modelConfigName: row?.name,
          messages: agentMessages,
          temperature: body.temperature,
          maxTokens: body.max_tokens,
          topP: body.top_p,
          stopSequences: normalizeStop(body.stop),
          userId: user.id,
        };
        // Token-true only where the provider's stream is its completion; every
        // other reply is completed and chunked whole, as below. `agent.streaming:
        // false` means no streamed provider calls at all.
        if (wantStream && getConfig().agent?.streaming !== false
          && (await getProviderRouter().resolveProvider(options.model, options)).streamIsComplete === true) {
          const streamed = await openPassthroughStream(id, model, options, request.signal);
          if (!streamed) {
            // The client left during the lookups above: no provider call was made.
            apiLogger.info({ model }, '/v1/chat/completions: client gone before the provider call — not sent');
            set.status = 499;
            return oaiError('The client closed the request', 'invalid_request_error', 'client_closed');
          }
          Object.assign(set.headers, SSE_HEADERS);
          return streamed;
        }
        const result = await getProviderRouter().complete(options);

        const usage = {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.totalTokens,
        };

        if (wantStream) {
          Object.assign(set.headers, SSE_HEADERS);
          return streamCompletion(id, result.model || model, result.content);
        }
        return toChatCompletion(id, result.model || model, result.content, usage);
      } catch (err) {
        const budget = budgetErrorBody(err);
        if (budget) { set.status = 429; return oaiError(budget.error, 'rate_limit_exceeded', budget.code); }
        // A user's /stop dropped this agent-mode request while it waited
        // behind the session's running turn: nothing ran. A conflict, not a fault.
        if (isSessionTurnCancelled(err)) {
          apiLogger.info({ model }, '/v1/chat/completions request dropped by stop');
          set.status = 409;
          return oaiError(err.message, 'invalid_request_error', 'turn_cancelled');
        }
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

/**
 * Start a token-true passthrough stream. The provider is read up to its first
 * chunk before any byte is sent, so a request it refuses (unknown model, quota,
 * an open circuit, a provider error) gets its HTTP status and error envelope
 * from that one attempt: it is not retried without streaming. Null when the
 * client has already gone: the provider is not called at all.
 */
async function openPassthroughStream(id: string, model: string, options: CompletionOptions, client: AbortSignal) {
  if (client.aborted) return null;
  const provider = new AbortController();
  const stopEarly = () => provider.abort(client.reason);
  client.addEventListener('abort', stopEarly, { once: true });
  const chunks = getProviderRouter().stream({ ...options, signal: provider.signal });
  let first: IteratorResult<StreamChunk>;
  try {
    first = await chunks.next();
  } catch (err) {
    provider.abort();
    throw err;
  } finally {
    client.removeEventListener('abort', stopEarly);
  }
  return passthroughSse({ id, model, chunks, first, provider, client, stallTimeoutMs: getConfig().api.streamStallTimeoutMs });
}

/** Normalize OpenAI `stop` (string | string[] | undefined) to string[] | undefined. */
function normalizeStop(stop: string | string[] | undefined): string[] | undefined {
  if (stop === undefined) return undefined;
  return Array.isArray(stop) ? stop : [stop];
}

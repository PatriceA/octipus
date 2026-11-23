/**
 * OpenTelemetry spans at the real boundaries: the HTTP application layer, a
 * turn (`traceTurn`, the wrapper `AgentService` runs every turn in), the
 * provider accounting boundary every model call crosses, and the tool
 * executor. Spans land in an in-memory exporter.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ log: vi.fn(async () => ({})) }));
// The provider boundary's own collaborators (as in instrumented.test.ts).
vi.mock('@/models/install-access', () => ({ assertInstallModelAccess: async () => undefined }));
vi.mock('@/models/cost-tracker', () => ({ getCostTracker: () => ({ logUsageWithCost: mocks.log }) }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModel: async () => null, getModelByModelId: async () => null }) }));
vi.mock('@/core/protection/routing', () => ({ assertMayLeave: async () => undefined, PSEUDONYMIZED: {}, pseudonymsFor: async () => undefined }));

import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { Elysia } from '@/api/http';
import { messageRepository } from '@/db/repositories/message-repository';
import type { CompletionOptions, CompletionResult, StreamChunk } from '@/models/litellm-client';
import { accountCompletion, accountStream } from '@/models/providers/instrumented';
import { traceTurn } from './agent/service';
import type { ToolHandler } from './agent-base';
import { ToolExecutor } from './tool-executor';
import {
  initTracing, injectTraceHeaders, isTracingEnabled, resetTracingForTests, SPAN_ATTRIBUTE_KEYS,
  tracingConfigFromEnv, withSpan,
} from './tracing';
import type { AgentContext } from './types';

// Content that must never reach a span: a prompt, a completion, tool
// arguments, a tool result, an error message quoting user text, a credential.
const PROMPT = 'PROMPT-sentinel-please-summarise-my-medical-records';
const COMPLETION = 'COMPLETION-sentinel-here-is-the-summary';
const TOOL_ARG = 'TOOLARG-sentinel-/home/alice/diary.txt';
const TOOL_RESULT = 'TOOLRESULT-sentinel-dear-diary';
const ERROR_TEXT = 'ERRORMSG-sentinel-could-not-open-alice-diary';
const QUERY_TOKEN = 'QUERYTOKEN-sentinel-share-link';
const SENTINELS = [PROMPT, COMPLETION, TOOL_ARG, TOOL_RESULT, ERROR_TEXT, QUERY_TOKEN];

const INCOMING_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const INCOMING_PARENT = '00f067aa0ba902b7';
const TRACEPARENT = `00-${INCOMING_TRACE}-${INCOMING_PARENT}-01`;

const ON = { OTEL_TRACES_EXPORTER: 'otlp' } as NodeJS.ProcessEnv;

let exporter: InMemorySpanExporter;

async function start(env: NodeJS.ProcessEnv): Promise<void> {
  exporter = new InMemorySpanExporter();
  await initTracing({ env, spanProcessors: [new SimpleSpanProcessor(exporter)] });
}

const options: CompletionOptions = {
  model: 'probe-model',
  messages: [{ role: 'user', content: PROMPT, timestamp: new Date(0) }],
  userId: '11111111-1111-1111-1111-111111111111',
  sessionId: '22222222-2222-2222-2222-222222222222',
};
const completion: CompletionResult = {
  content: COMPLETION, finishReason: 'stop', model: 'probe-model-2026', latencyMs: 1,
  usage: { inputTokens: 120, outputTokens: 7, totalTokens: 127, cacheReadTokens: 100 },
};

function agentContext(): AgentContext {
  return {
    space: null, trigger: 'user', funding: 'own', id: 'agent-root', sessionId: options.sessionId!, userId: options.userId!,
    model: 'probe-model', topic: '', role: 'general', root: true, status: 'running',
    createdAt: new Date(0), updatedAt: new Date(0), metadata: {},
  };
}

class DiaryUnreadable extends Error {}

/**
 * A request that runs a turn: one model call, then a tool that makes a model
 * call of its own (as `spawn_child` does), then a tool that fails with a
 * message quoting user content.
 */
function app() {
  return new Elysia().post('/api/sessions/:id/probe', async ({ params }) => {
    const result = await traceTurn({ runId: 'run_probe', sessionId: params.id, channel: 'api', trigger: 'user' }, async () => {
      await accountCompletion(options, 'openai', async () => completion);
      const executor = new ToolExecutor(agentContext(), () => {});
      const reader: ToolHandler = {
        name: 'read_diary', toolId: 'agent', description: 'reads', parameters: {},
        execute: async () => {
          await accountCompletion({ ...options, requestType: 'compaction' }, 'anthropic', async () => completion);
          return TOOL_RESULT;
        },
      };
      const failing: ToolHandler = {
        name: 'open_diary', toolId: 'agent', description: 'opens', parameters: {},
        execute: async () => { throw new DiaryUnreadable(ERROR_TEXT); },
      };
      executor.registerTool(reader);
      executor.registerTool(failing);
      await executor.handleToolCalls([
        { id: 'call-1', name: 'read_diary', arguments: { path: TOOL_ARG } },
        { id: 'call-2', name: 'open_diary', arguments: { path: TOOL_ARG } },
      ]);
      return { response: COMPLETION, outcome: 'success' as const, classification: { type: 'casual' } };
    });
    return { ok: result.outcome };
  });
}

function request(headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/sessions/${options.sessionId}/probe?token=${QUERY_TOKEN}&t=${QUERY_TOKEN}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text: PROMPT }),
  });
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

function one(spans: ReadableSpan[], name: string): ReadableSpan {
  const found = byName(spans, name);
  expect(found, name).toHaveLength(1);
  return found[0];
}

const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

beforeEach(() => {
  vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await resetTracingForTests();
});

describe('tracing configuration', () => {
  test('off unless an OTLP endpoint or exporter is configured', () => {
    expect(tracingConfigFromEnv({}).enabled).toBe(false);
    expect(tracingConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }).enabled).toBe(true);
    expect(tracingConfigFromEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces' }).enabled).toBe(true);
    expect(tracingConfigFromEnv({ OTEL_TRACES_EXPORTER: 'otlp' }).enabled).toBe(true);
  });

  test('OTEL_SDK_DISABLED and OTEL_TRACES_EXPORTER=none win over an endpoint', () => {
    expect(tracingConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SDK_DISABLED: 'true' }).enabled).toBe(false);
    expect(tracingConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_TRACES_EXPORTER: 'none' }).enabled).toBe(false);
  });

  test('an exporter or protocol this build cannot honour fails loud', () => {
    expect(() => tracingConfigFromEnv({ OTEL_TRACES_EXPORTER: 'zipkin' })).toThrow(/only "otlp"/);
    expect(() => tracingConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toThrow(/grpc/);
    // Not enabled, so a protocol alone is not an error.
    expect(tracingConfigFromEnv({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }).enabled).toBe(false);
  });
});

describe('spans while tracing is on', () => {
  test('request → agent run → model call and tool calls nest, across every await', async () => {
    await start(ON);
    const res = await app().handle(request());
    expect(res.status).toBe(200);
    const spans = exporter.getFinishedSpans();

    const server = one(spans, 'POST /api/sessions/:id/probe');
    const run = one(spans, 'agent.run');
    const tools = spans.filter((s) => s.name.startsWith('execute_tool '));
    const models = byName(spans, 'chat probe-model');

    expect(parentOf(server)).toBeUndefined();
    expect(parentOf(run)).toBe(server.spanContext().spanId);
    expect(tools.map((s) => s.name).sort()).toEqual(['execute_tool open_diary', 'execute_tool read_diary']);
    for (const tool of tools) expect(parentOf(tool)).toBe(run.spanContext().spanId);
    // The turn's own call sits under the run; the one the tool made sits under the tool.
    const reader = one(spans, 'execute_tool read_diary');
    expect(models.map(parentOf).sort()).toEqual([run.spanContext().spanId, reader.spanContext().spanId].sort());
    // One trace end to end.
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);

    expect(server.attributes).toMatchObject({ 'http.request.method': 'POST', 'http.route': '/api/sessions/:id/probe', 'http.response.status_code': 200 });
    expect(run.attributes).toMatchObject({ 'octipus.run_id': 'run_probe', 'octipus.session_id': options.sessionId, 'octipus.outcome': 'success', 'octipus.topic': 'casual' });
    const turnCall = models.find((s) => parentOf(s) === run.spanContext().spanId)!;
    expect(turnCall.attributes).toMatchObject({
      'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'probe-model', 'gen_ai.response.model': 'probe-model-2026',
      'gen_ai.usage.input_tokens': 120, 'gen_ai.usage.output_tokens': 7, 'gen_ai.usage.cache_read.input_tokens': 100,
      'octipus.llm.streaming': false,
    });
    expect(reader.attributes).toMatchObject({ 'gen_ai.tool.name': 'read_diary', 'gen_ai.tool.call.id': 'call-1', 'octipus.agent.id': 'agent-root' });
  });

  test('an incoming traceparent is continued, not restarted', async () => {
    await start(ON);
    await app().handle(request({ traceparent: TRACEPARENT }));
    const spans = exporter.getFinishedSpans();
    const server = one(spans, 'POST /api/sessions/:id/probe');
    expect(server.spanContext().traceId).toBe(INCOMING_TRACE);
    expect(parentOf(server)).toBe(INCOMING_PARENT);
    expect(spans.every((s) => s.spanContext().traceId === INCOMING_TRACE)).toBe(true);
  });

  test('outgoing headers carry the active span, and a configured traceparent is kept', async () => {
    await start(ON);
    let headers: Record<string, string> = {};
    let kept: Record<string, string> = {};
    await withSpan('webhook.deliver', {}, async () => {
      headers = injectTraceHeaders({ 'Content-Type': 'application/json' });
      kept = injectTraceHeaders({ Traceparent: TRACEPARENT });
    });
    const span = one(exporter.getFinishedSpans(), 'webhook.deliver');
    expect(headers.traceparent).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
    expect(kept).toEqual({ Traceparent: TRACEPARENT });
  });

  test('a failure records the error class and status, never the message', async () => {
    await start(ON);
    await app().handle(request());
    const failed = one(exporter.getFinishedSpans(), 'execute_tool open_diary');
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.status.message).toBeUndefined();
    expect(failed.attributes['error.type']).toBe('DiaryUnreadable');
    expect(failed.events).toEqual([]);
  });

  test('a streamed model call is marked streaming and carries its usage', async () => {
    await start(ON);
    const chunks: StreamChunk[] = [{ content: COMPLETION }, { usage: completion.usage, finishReason: 'stop' }];
    await withSpan('agent.run', {}, async () => {
      for await (const _ of accountStream(options, 'openai', async function* () { yield* chunks; })) { /* drain */ }
    });
    const call = one(exporter.getFinishedSpans(), 'chat probe-model');
    expect(call.attributes).toMatchObject({ 'octipus.llm.streaming': true, 'gen_ai.usage.output_tokens': 7, 'octipus.outcome': 'success' });
    expect(parentOf(call)).toBe(one(exporter.getFinishedSpans(), 'agent.run').spanContext().spanId);
  });

  test('a failed turn answered as a value marks its span failed', async () => {
    await start(ON);
    await traceTurn({ runId: 'run_f', sessionId: 's', channel: 'api', trigger: 'user' }, async () => (
      { outcome: 'failed' as const, classification: { type: 'casual' } }));
    const run = one(exporter.getFinishedSpans(), 'agent.run');
    expect(run.status.code).toBe(SpanStatusCode.ERROR);
    expect(run.attributes['error.type']).toBe('TurnFailed');
  });

  test('no prompt, completion, argument, result, error text or token reaches a span', async () => {
    await start(ON);
    await app().handle(request({ traceparent: TRACEPARENT }));
    await withSpan('agent.run', {}, async () => {
      for await (const _ of accountStream(options, 'openai', async function* () { yield { content: COMPLETION }; })) { /* drain */ }
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(5);
    const allowed = new Set<string>(SPAN_ATTRIBUTE_KEYS);
    for (const span of spans) {
      for (const key of Object.keys(span.attributes)) expect(allowed.has(key), `${span.name}: ${key}`).toBe(true);
      const exported = JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events, status: span.status, links: span.links });
      for (const sentinel of SENTINELS) expect(exported, `${span.name} leaks ${sentinel}`).not.toContain(sentinel);
    }
    // The query string is not recorded at all.
    expect(one(spans, 'POST /api/sessions/:id/probe').attributes['url.path']).toBe(`/api/sessions/${options.sessionId}/probe`);
  });
});

describe('spans while tracing is off', () => {
  test('nothing is emitted and no trace header goes out', async () => {
    await start({});
    expect(isTracingEnabled()).toBe(false);
    const res = await app().handle(request({ traceparent: TRACEPARENT }));
    expect(res.status).toBe(200);
    let headers: Record<string, string> = {};
    await withSpan('webhook.deliver', {}, async () => { headers = injectTraceHeaders({}); });
    expect(headers).toEqual({});
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

/**
 * OpenTelemetry spans at the real boundaries: the HTTP application layer, a
 * turn (`traceTurn`, the wrapper `AgentService` runs every turn in), the
 * provider accounting boundary every model call crosses, and the tool
 * executor. Spans land in an in-memory exporter.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { coreLogger } from '@/utils/logger';
import { traceTurn } from './agent/service';
import type { ToolHandler } from './agent-base';
import { ToolExecutor } from './tool-executor';
import {
  initTracing, injectTraceHeaders, isTracingEnabled, resetTracingForTests, shutdownTracing, SPAN_ATTRIBUTE_KEYS,
  startSpan, tracingConfigFromEnv, withSpan,
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
const TRUSTING = { ...ON, OCTIPUS_TRACE_TRUST_INBOUND: 'true' } as NodeJS.ProcessEnv;
const PROPAGATING = { ...ON, OCTIPUS_TRACE_PROPAGATE_OUTBOUND: 'true' } as NodeJS.ProcessEnv;

/** A stand-in OTLP collector answering every export with `status`. */
async function collector(status = 200) {
  const received: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

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

  test('a configuration this build cannot honour leaves tracing off, logged, and never throws', async () => {
    const errors = vi.spyOn(coreLogger, 'error');
    for (const env of [
      { OTEL_TRACES_EXPORTER: 'console' },
      { OTEL_TRACES_EXPORTER: 'zipkin', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' },
    ]) {
      const config = tracingConfigFromEnv(env);
      expect(config.enabled, JSON.stringify(env)).toBe(false);
      expect(config.error).toBeTruthy();
      await expect(initTracing({ env })).resolves.toMatchObject({ enabled: false });
      expect(isTracingEnabled()).toBe(false);
    }
    expect(errors).toHaveBeenCalledTimes(3);
    // Not enabled, so a protocol alone is not an error.
    expect(tracingConfigFromEnv({ OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }).error).toBeUndefined();
  });

  test('otlp next to other exporters exports to OTLP and warns about the rest', () => {
    const config = tracingConfigFromEnv({ OTEL_TRACES_EXPORTER: 'otlp,console' });
    expect(config.enabled).toBe(true);
    expect(config.warnings.join()).toMatch(/console/);
    expect(tracingConfigFromEnv({ OTEL_TRACES_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf' }).warnings.join()).toMatch(/JSON/);
  });

  test('the exporter, resource and sampler follow the env initTracing was given', async () => {
    const c = await collector();
    try {
      await initTracing({ env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: `${c.url}/`, OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=k%3D1', OTEL_SERVICE_NAME: 'from-env',
        OTEL_TRACES_SAMPLER: 'always_on',
      } });
      startSpan('agent.run').end();
      await shutdownTracing(5000);
      expect(c.received).toHaveLength(1);
      expect(c.received[0].url).toBe('/v1/traces');
      expect(c.received[0].headers['x-collector-key']).toBe('k=1');
      expect(c.received[0].body).toContain('"stringValue":"from-env"');
    } finally {
      await c.close();
    }
  });
});

describe('shutdown and a collector that is down', () => {
  test('the flush is capped, well inside the shutdown watchdog', async () => {
    // Port 1: nothing listens, the exporter retries with backoff (8 s measured).
    await initTracing({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' } });
    startSpan('agent.run').end();
    const started = Date.now();
    await shutdownTracing(300);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(isTracingEnabled()).toBe(false);
  });

  test('repeated export failures are warned once, not on every export', async () => {
    const c = await collector(400);
    const warns = vi.spyOn(coreLogger, 'warn');
    try {
      await initTracing({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: c.url, OTEL_BSP_SCHEDULE_DELAY: '5' } });
      for (let i = 0; i < 3; i++) {
        startSpan('agent.run').end();
        await vi.waitFor(() => expect(c.received.length).toBe(i + 1));
        await new Promise((r) => setTimeout(r, 20));
      }
      await shutdownTracing(2000);
      const otel = warns.mock.calls.filter(([, msg]) => typeof msg === 'string' && msg.startsWith('OpenTelemetry:'));
      expect(c.received.length).toBe(3);
      expect(otel).toHaveLength(1);
    } finally {
      await c.close();
    }
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

  test('an untrusted caller\'s traceparent starts a new trace, linked, and cannot switch sampling off', async () => {
    await start(ON);
    // Flags 00: "not sampled". Honoured, a parent-based sampler would drop the request.
    await app().handle(request({ traceparent: `00-${INCOMING_TRACE}-${INCOMING_PARENT}-00` }));
    const spans = exporter.getFinishedSpans();
    const server = one(spans, 'POST /api/sessions/:id/probe');
    expect(server.spanContext().traceId).not.toBe(INCOMING_TRACE);
    expect(parentOf(server)).toBeUndefined();
    expect(server.links.map((l) => [l.context.traceId, l.context.spanId])).toEqual([[INCOMING_TRACE, INCOMING_PARENT]]);
    expect(spans.some((s) => s.spanContext().traceId === INCOMING_TRACE)).toBe(false);
  });

  test('with OCTIPUS_TRACE_TRUST_INBOUND an incoming traceparent is continued, not restarted', async () => {
    await start(TRUSTING);
    await app().handle(request({ traceparent: TRACEPARENT }));
    const spans = exporter.getFinishedSpans();
    const server = one(spans, 'POST /api/sessions/:id/probe');
    expect(server.spanContext().traceId).toBe(INCOMING_TRACE);
    expect(parentOf(server)).toBe(INCOMING_PARENT);
    expect(server.links).toEqual([]);
    expect(spans.every((s) => s.spanContext().traceId === INCOMING_TRACE)).toBe(true);
  });

  test('outgoing headers carry no trace context unless propagation is opted in', async () => {
    await start(ON);
    let headers: Record<string, string> = {};
    await withSpan('webhook.deliver', {}, async () => { headers = injectTraceHeaders({ 'Content-Type': 'application/json' }); });
    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  test('opted in, outgoing headers carry traceparent only, and a configured one is kept', async () => {
    await start(PROPAGATING);
    let headers: Record<string, string> = {};
    let kept: Record<string, string> = {};
    await withSpan('webhook.deliver', {}, async () => {
      headers = injectTraceHeaders({ 'Content-Type': 'application/json' });
      kept = injectTraceHeaders({ Traceparent: TRACEPARENT });
    });
    const span = one(exporter.getFinishedSpans(), 'webhook.deliver');
    expect(headers).toEqual({ 'Content-Type': 'application/json', traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01` });
    expect(kept).toEqual({ Traceparent: TRACEPARENT });
  });

  test('a tracestate an inbound caller sent is never forwarded', async () => {
    await start({ ...TRUSTING, OCTIPUS_TRACE_PROPAGATE_OUTBOUND: 'true' });
    let headers: Record<string, string> = {};
    const probe = new Elysia().get('/api/relay', async () => {
      await withSpan('webhook.deliver', {}, async () => { headers = injectTraceHeaders({}); });
      return { ok: true };
    });
    await probe.handle(new Request('http://localhost/api/relay', { headers: { traceparent: TRACEPARENT, tracestate: 'vendor=QUERYTOKEN' } }));
    expect(headers.traceparent).toMatch(new RegExp(`^00-${INCOMING_TRACE}-`));
    expect(Object.keys(headers)).toEqual(['traceparent']);
  });

  test('a matched route records its template, not its path; an unmatched one its redacted path', async () => {
    await start(ON);
    const tokens = new Elysia().post('/api/devices/push-token/:token', async () => ({ ok: true }));
    await tokens.handle(new Request(`http://localhost/api/devices/push-token/${QUERY_TOKEN}`, { method: 'POST' }));
    await tokens.handle(new Request(`http://localhost/api/media/public/${QUERY_TOKEN}/x?t=${QUERY_TOKEN}`));
    const spans = exporter.getFinishedSpans();
    const matched = one(spans, 'POST /api/devices/push-token/:token');
    expect(matched.attributes['url.path']).toBeUndefined();
    expect(matched.attributes['http.route']).toBe('/api/devices/push-token/:token');
    const missed = one(spans, 'GET');
    expect(missed.attributes['url.path']).toBe('/api/media/public/[REDACTED]/x');
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain(QUERY_TOKEN);
  });

  test('health and metrics requests are not traced', async () => {
    await start(ON);
    const probes = new Elysia().get('/api/health', () => ({ ok: true })).get('/api/metrics', () => 'm').get('/api/health/detailed', () => ({ ok: true }));
    for (const path of ['/api/health', '/api/health/detailed', '/api/metrics']) {
      expect((await probes.handle(new Request(`http://localhost${path}`))).status).toBe(200);
    }
    expect(exporter.getFinishedSpans()).toEqual([]);
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
  });

  test('a stream its reader stops early, or that fails, still ends its span', async () => {
    await start(ON);
    const chunks: StreamChunk[] = [{ content: 'a' }, { content: 'b' }, { usage: completion.usage, finishReason: 'stop' }];
    for await (const _ of accountStream(options, 'openai', async function* () { yield* chunks; })) break;
    await expect((async () => {
      for await (const _ of accountStream(options, 'openai', async function* () { yield { content: 'a' }; throw new DiaryUnreadable(ERROR_TEXT); })) { /* drain */ }
    })()).rejects.toThrow(DiaryUnreadable);
    const calls = byName(exporter.getFinishedSpans(), 'chat probe-model');
    expect(calls).toHaveLength(2);
    const [stopped, failed] = calls;
    expect(stopped.attributes['octipus.outcome']).toBe('incomplete');
    expect(stopped.status.code).toBe(SpanStatusCode.UNSET);
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes['error.type']).toBe('DiaryUnreadable');
  });

  test('a stream that fails before the request (local runner gate) ends its span', async () => {
    await start(ON);
    const gate = await import('@/models/local-gate');
    vi.spyOn(gate, 'localRunnerKey').mockReturnValue('ollama:default');
    vi.spyOn(gate, 'getLocalModelGate').mockReturnValue({ enter: async () => { throw new DiaryUnreadable('busy'); } } as never);
    await expect((async () => {
      for await (const _ of accountStream(options, 'ollama', async function* () { yield { content: 'a' }; })) { /* drain */ }
    })()).rejects.toThrow(DiaryUnreadable);
    const call = one(exporter.getFinishedSpans(), 'chat probe-model');
    expect(call.attributes['error.type']).toBe('DiaryUnreadable');
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

/**
 * Tracing — OpenTelemetry spans (WS4 observability, the half after metrics).
 *
 * Off by default, like the metrics endpoint. It is switched on by the standard
 * OpenTelemetry environment variables (`tracingConfigFromEnv`): an OTLP
 * endpoint, or `OTEL_TRACES_EXPORTER=otlp`. While it is off, every helper
 * below returns before touching the OpenTelemetry API, and the SDK packages
 * are never loaded: they are imported in `initTracing` only once the
 * environment asks for traces. `@opentelemetry/api` is the one static import;
 * it is dependency-free and inert until a provider is registered.
 *
 * What a span may carry: ids, names, counts, durations, status and the error
 * class. Never a prompt, a completion, tool arguments or results, message
 * text, a secret or a token. That is enforced by type, not by review alone:
 * attributes go through `SpanAttributes`, whose keys are the closed set
 * `SpanAttributeKey`, and an error is recorded as its class (`error.type`),
 * never its message, which can quote user content. `recordException` is
 * deliberately not used: it stores the message and the stack.
 *
 * Parent/child relations follow the async call tree through the
 * `AsyncLocalStorage` context manager registered at init, so a model call made
 * inside a tool made inside a turn nests under both without threading.
 */
import {
  context,
  diag,
  DiagLogLevel,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { coreLogger } from '@/utils/logger';
import { redactUrlForLog } from '@/utils/log-redact';

export { SpanKind } from '@opentelemetry/api';

/** The instrumentation scope every Octipus span is created under. */
export const TRACER_NAME = 'octipus';

/**
 * Every attribute key a span may carry. Adding one is a review decision:
 * nothing here may hold user content (see the module comment). The tests
 * check every exported attribute against this list.
 */
export const SPAN_ATTRIBUTE_KEYS = [
  // Inbound and outbound HTTP (OpenTelemetry semantic conventions).
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'url.path',
  'url.scheme',
  'server.address',
  'error.type',
  // A turn (run correlation, src/core/run-context.ts).
  'octipus.run_id',
  'octipus.session_id',
  'octipus.channel',
  'octipus.trigger',
  'octipus.outcome',
  'octipus.topic',
  // Agents.
  'octipus.agent.id',
  'octipus.agent.role',
  'octipus.agent.depth',
  'octipus.agent.parent_id',
  'octipus.agent.planned',
  'octipus.agent.child_status',
  // Pipelines.
  'octipus.pipeline.id',
  'octipus.pipeline.node_key',
  'octipus.pipeline.stage_kind',
  'octipus.pipeline.stage_type',
  // Model calls (GenAI semantic conventions, counts and names only).
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'octipus.llm.streaming',
  'octipus.llm.request_type',
  'octipus.llm.usage_estimated',
  // Tool calls.
  'gen_ai.tool.name',
  'gen_ai.tool.call.id',
  'octipus.tool.id',
  // Delivery.
  'octipus.channel.attachments',
] as const;

export type SpanAttributeKey = (typeof SPAN_ATTRIBUTE_KEYS)[number];

export type SpanAttributes = Partial<Record<SpanAttributeKey, string | number | boolean | null | undefined>>;

/** A span as the call sites see it. A no-op while tracing is off. */
export interface TraceSpan {
  setAttributes(attributes: SpanAttributes): void;
  /** Mark the span failed with the class of `error` (never its message). */
  fail(error: unknown): void;
  /** Mark the span failed with a named class, for a failure that is a value rather than a throw. */
  failWith(errorType: string): void;
  end(): void;
  /** Run `fn` with this span as the active parent of the spans it starts. */
  run<T>(fn: () => T): T;
}

const NOOP_SPAN: TraceSpan = {
  setAttributes() {},
  fail() {},
  failWith() {},
  end() {},
  run: (fn) => fn(),
};

/** What the environment asks for. `enabled: false` means no SDK is loaded. */
export interface TracingConfig {
  enabled: boolean;
  /** Why it is on or off, for the boot log line. */
  reason: string;
}

const truthy = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'true';
const present = (v: string | undefined) => (v ?? '').trim().length > 0;

/**
 * Read the standard OpenTelemetry variables. Tracing is on when an OTLP
 * endpoint is configured (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
 * `OTEL_EXPORTER_OTLP_ENDPOINT`) or `OTEL_TRACES_EXPORTER=otlp` (the
 * exporter's default endpoint, `http://localhost:4318/v1/traces`), and off
 * otherwise, with `OTEL_SDK_DISABLED=true` and `OTEL_TRACES_EXPORTER=none`
 * winning over both. An exporter or protocol this build cannot honour throws:
 * a misconfigured collector is said at boot, not discovered as an empty
 * dashboard.
 */
export function tracingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TracingConfig {
  if (truthy(env.OTEL_SDK_DISABLED)) return { enabled: false, reason: 'OTEL_SDK_DISABLED=true' };
  const exporters = (env.OTEL_TRACES_EXPORTER ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (exporters.includes('none')) return { enabled: false, reason: 'OTEL_TRACES_EXPORTER=none' };
  const unsupported = exporters.filter((e) => e !== 'otlp');
  if (unsupported.length > 0) {
    throw new Error(`OTEL_TRACES_EXPORTER=${env.OTEL_TRACES_EXPORTER}: only "otlp" (or "none") is supported`);
  }
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? '').trim().toLowerCase();
  const endpoint = present(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) || present(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const enabled = exporters.includes('otlp') || endpoint;
  if (enabled && protocol === 'grpc') {
    throw new Error('OTEL_EXPORTER_OTLP_PROTOCOL=grpc is not supported: traces are exported over OTLP/HTTP (port 4318)');
  }
  if (!enabled) return { enabled: false, reason: 'no OTLP endpoint configured' };
  return { enabled: true, reason: endpoint ? 'OTLP endpoint configured' : 'OTEL_TRACES_EXPORTER=otlp' };
}

let enabled = false;
let provider: { forceFlush(): Promise<void>; shutdown(): Promise<void> } | null = null;

/** True once `initTracing` registered a provider. */
export function isTracingEnabled(): boolean {
  return enabled;
}

export interface InitTracingOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Span processors to use instead of the OTLP batch exporter (tests pass an
   * in-memory exporter). Whether tracing is on is still the environment's call.
   */
  spanProcessors?: import('@opentelemetry/sdk-trace-base').SpanProcessor[];
}

/**
 * Register the tracer provider, the `AsyncLocalStorage` context manager and
 * the W3C trace-context propagator, if the environment enables tracing.
 * Called once, first thing at boot. A second call is refused: the
 * OpenTelemetry globals can be registered once per process.
 */
export async function initTracing(options: InitTracingOptions = {}): Promise<TracingConfig> {
  if (enabled) throw new Error('Tracing is already initialised');
  const env = options.env ?? process.env;
  const config = tracingConfigFromEnv(env);
  if (!config.enabled) {
    coreLogger.debug({ reason: config.reason }, 'Tracing off');
    return config;
  }
  const [{ BasicTracerProvider, BatchSpanProcessor }, { AsyncLocalStorageContextManager }, { W3CTraceContextPropagator }, resources] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/context-async-hooks'),
      import('@opentelemetry/core'),
      import('@opentelemetry/resources'),
    ]);
  const { getAppVersion } = await import('@/utils/version');

  // Exporter failures (a collector that is down, a bad endpoint) reach the
  // log instead of vanishing into the SDK's silent default diag logger.
  diag.setLogger({
    error: (msg, ...args) => coreLogger.warn({ args }, `OpenTelemetry: ${msg}`),
    warn: (msg, ...args) => coreLogger.warn({ args }, `OpenTelemetry: ${msg}`),
    info: () => {},
    debug: () => {},
    verbose: () => {},
  }, DiagLogLevel.WARN);

  let spanProcessors = options.spanProcessors;
  if (!spanProcessors) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    // The exporter reads its endpoint, headers, timeout and compression from
    // the OTEL_EXPORTER_OTLP_* variables itself; the batch processor its
    // queue and delay from OTEL_BSP_*.
    spanProcessors = [new BatchSpanProcessor(new OTLPTraceExporter())];
  }
  // `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` (the env detector) win
  // over the defaults here.
  const resource = resources.defaultResource()
    .merge(resources.resourceFromAttributes({ 'service.name': 'octipus', 'service.version': getAppVersion() }))
    .merge(resources.detectResources({ detectors: [resources.envDetector] }));
  // The sampler comes from OTEL_TRACES_SAMPLER / _ARG (default: parent-based, always on).
  const tracerProvider = new BasicTracerProvider({ resource, spanProcessors });

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  provider = tracerProvider;
  enabled = true;
  coreLogger.info({ reason: config.reason }, 'Tracing on: exporting spans over OTLP');
  return config;
}

/** Flush and stop the exporter. Called at shutdown; a no-op while tracing is off. */
export async function shutdownTracing(): Promise<void> {
  if (!provider) return;
  const current = provider;
  provider = null;
  enabled = false;
  try {
    await current.shutdown();
  } catch (err) {
    coreLogger.warn({ err }, 'Flushing spans at shutdown failed');
  }
}

/** Tests only: drop the registered globals so the next `initTracing` starts clean. */
export async function resetTracingForTests(): Promise<void> {
  if (provider) await provider.shutdown();
  provider = null;
  enabled = false;
  trace.disable();
  context.disable();
  propagation.disable();
  diag.disable();
}

/** The class of a thrown value, safe to export: a code identifier, never a message. */
export function errorTypeOf(error: unknown): string {
  if (error instanceof Error) {
    // A subclass that sets no `name` inherits `Error`: its constructor names it.
    if (error.name !== 'Error' && /^[A-Za-z_$][\w$.]{0,63}$/.test(error.name)) return error.name;
    const ctor = error.constructor?.name;
    return ctor && /^[A-Za-z_$][\w$]{0,63}$/.test(ctor) ? ctor : 'Error';
  }
  return error === null ? 'null' : typeof error;
}

function toAttributes(attributes: SpanAttributes | undefined): Attributes {
  const out: Attributes = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    // Ids and names are short; anything long is not what an attribute is for.
    out[key] = typeof value === 'string' && value.length > 256 ? value.slice(0, 256) : value;
  }
  return out;
}

/**
 * Spans already failed with a class: a later, vaguer failure (a turn wrapper
 * seeing `outcome: 'failed'` after the turn recorded the error that caused
 * it) keeps the first, more specific class.
 */
const failedSpans = new WeakSet<Span>();

function markFailed(span: Span, errorType: string): void {
  if (!failedSpans.has(span)) {
    failedSpans.add(span);
    span.setAttribute('error.type', errorType);
  }
  span.setStatus({ code: SpanStatusCode.ERROR });
}

function wrap(span: Span): TraceSpan {
  return {
    setAttributes(attributes) {
      span.setAttributes(toAttributes(attributes));
    },
    fail(error) {
      this.failWith(errorTypeOf(error));
    },
    failWith(errorType) {
      markFailed(span, errorType);
    },
    end() {
      span.end();
    },
    run(fn) {
      return context.with(trace.setSpan(context.active(), span), fn);
    },
  };
}

function guarded(fn: () => TraceSpan): TraceSpan {
  try {
    return fn();
  } catch (err) {
    // A tracing bug must never break a request or a turn.
    coreLogger.debug({ err }, 'span creation failed (ignored)');
    return NOOP_SPAN;
  }
}

/**
 * Start a span under the active one (or under `parent`). The caller ends it;
 * `withSpan` is the shape for anything that fits in one function.
 */
export function startSpan(name: string, attributes?: SpanAttributes, kind: SpanKind = SpanKind.INTERNAL, parent?: Context): TraceSpan {
  if (!enabled) return NOOP_SPAN;
  return guarded(() => wrap(trace.getTracer(TRACER_NAME).startSpan(name, { kind, attributes: toAttributes(attributes) }, parent ?? context.active())));
}

/**
 * Run `fn` inside a span: active for everything `fn` starts, failed with the
 * error's class if it throws, ended either way.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: TraceSpan) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  if (!enabled) return fn(NOOP_SPAN);
  const span = startSpan(name, attributes, kind);
  try {
    return await span.run(() => fn(span));
  } catch (error) {
    span.fail(error);
    throw error;
  } finally {
    span.end();
  }
}

/** Add attributes to the active span (an agent run learning its topic, say). */
export function setActiveSpanAttributes(attributes: SpanAttributes): void {
  if (!enabled) return;
  trace.getActiveSpan()?.setAttributes(toAttributes(attributes));
}

/** Mark the active span failed with the class of `error`. */
export function failActiveSpan(error: unknown): void {
  if (!enabled) return;
  const span = trace.getActiveSpan();
  if (span) markFailed(span, errorTypeOf(error));
}

/**
 * Add the active trace context (`traceparent`, `tracestate`) to outgoing
 * request headers. A header of that name already there (one an operator
 * configured on purpose) is kept.
 */
export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  if (!enabled) return headers;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const taken = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [key, value] of Object.entries(carrier)) {
    if (!taken.has(key.toLowerCase())) headers[key] = value;
  }
  return headers;
}

const headerGetter = {
  get: (carrier: Headers, key: string) => carrier.get(key) ?? undefined,
  keys: (carrier: Headers) => [...carrier.keys()],
};

/**
 * The SERVER span of one inbound HTTP request, continuing the caller's trace
 * when it sent a W3C `traceparent`. The path is recorded through the log
 * redactor (capability tokens in the path are replaced) and the query string
 * not at all: it carries share tokens and search text. `statusOf` reads the
 * response status once `fn` has answered.
 */
export async function withInboundHttpSpan<T>(request: Request, fn: () => Promise<T>, statusOf: (result: T) => number | undefined): Promise<T> {
  if (!enabled) return fn();
  const url = new URL(redactUrlForLog(request.url));
  const parent = propagation.extract(ROOT_CONTEXT, request.headers, headerGetter);
  const span = startSpan(request.method, {
    'http.request.method': request.method,
    'url.path': url.pathname,
    'url.scheme': url.protocol.replace(/:$/, ''),
  }, SpanKind.SERVER, parent);
  try {
    const result = await span.run(fn);
    const status = statusOf(result);
    if (status !== undefined) {
      span.setAttributes({ 'http.response.status_code': status });
      if (status >= 500) span.failWith(String(status));
    }
    return result;
  } catch (error) {
    span.fail(error);
    throw error;
  } finally {
    span.end();
  }
}

/** Name the active SERVER span after the matched route template (`POST /api/sessions/:id`). */
export function setHttpRoute(method: string, route: string): void {
  if (!enabled) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttribute('http.route', route);
  span.updateName(`${method} ${route}`);
}

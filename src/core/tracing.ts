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
  isSpanContextValid,
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
  /**
   * A configuration this build cannot honour. Tracing is then off and the
   * process boots: a fleet-wide `OTEL_*` setting must never stop the server.
   */
  error?: string;
  /** Settings that were ignored while tracing stays on. */
  warnings: string[];
  /** Continue a `traceparent` sent by the caller (`OCTIPUS_TRACE_TRUST_INBOUND=true`). */
  trustInbound: boolean;
  /** Send `traceparent` on outgoing webhook deliveries (`OCTIPUS_TRACE_PROPAGATE_OUTBOUND=true`). */
  propagateOutbound: boolean;
}

const truthy = (v: string | undefined) => (v ?? '').trim().toLowerCase() === 'true';
const present = (v: string | undefined) => (v ?? '').trim().length > 0;

/**
 * Read the standard OpenTelemetry variables. Tracing is on when an OTLP
 * endpoint is configured (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
 * `OTEL_EXPORTER_OTLP_ENDPOINT`) or `OTEL_TRACES_EXPORTER` lists `otlp` (the
 * exporter's default endpoint, `http://localhost:4318/v1/traces`), and off
 * otherwise, with `OTEL_SDK_DISABLED=true` and `OTEL_TRACES_EXPORTER=none`
 * winning over both. A configuration this build cannot honour (an exporter
 * list without `otlp`, the `grpc` protocol) leaves tracing off with `error`
 * set, for the boot log; other exporters next to `otlp` are ignored with a
 * warning. Never throws.
 */
export function tracingConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TracingConfig {
  const base = { warnings: [] as string[], trustInbound: truthy(env.OCTIPUS_TRACE_TRUST_INBOUND), propagateOutbound: truthy(env.OCTIPUS_TRACE_PROPAGATE_OUTBOUND) };
  if (truthy(env.OTEL_SDK_DISABLED)) return { ...base, enabled: false, reason: 'OTEL_SDK_DISABLED=true' };
  const exporters = (env.OTEL_TRACES_EXPORTER ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (exporters.includes('none')) return { ...base, enabled: false, reason: 'OTEL_TRACES_EXPORTER=none' };
  if (exporters.length > 0 && !exporters.includes('otlp')) {
    const error = `OTEL_TRACES_EXPORTER=${env.OTEL_TRACES_EXPORTER} is not supported (only "otlp" or "none"): tracing is off`;
    return { ...base, enabled: false, reason: 'unsupported exporter', error };
  }
  const ignored = exporters.filter((e) => e !== 'otlp');
  if (ignored.length > 0) base.warnings.push(`OTEL_TRACES_EXPORTER: ignoring ${ignored.join(', ')}; spans go to OTLP only`);
  const protocol = (env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL ?? '').trim().toLowerCase();
  const endpoint = present(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) || present(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const wanted = exporters.includes('otlp') || endpoint;
  if (!wanted) return { ...base, enabled: false, reason: 'no OTLP endpoint configured' };
  if (protocol === 'grpc') {
    const error = 'OTEL_EXPORTER_OTLP_PROTOCOL=grpc is not supported (traces go over OTLP/HTTP, port 4318): tracing is off';
    return { ...base, enabled: false, reason: 'unsupported protocol', error };
  }
  if (protocol === 'http/protobuf') base.warnings.push('OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf: spans are sent as OTLP/HTTP JSON, which collectors accept on the same port');
  return { ...base, enabled: true, reason: endpoint ? 'OTLP endpoint configured' : 'OTEL_TRACES_EXPORTER=otlp' };
}

/** `key=value,key2=value2` (values URL-encoded), as the OTEL_* header and resource variables are written. */
function keyValues(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch (err) {
      coreLogger.warn({ key, err }, 'OTEL_* key=value pair is not URL-encoded; using it as written');
      out[key] = value;
    }
  }
  return out;
}

const envNumber = (v: string | undefined): number | undefined => {
  const n = Number((v ?? '').trim());
  return present(v) && Number.isFinite(n) && n >= 0 ? n : undefined;
};

/** The OTLP traces URL the variables describe (the per-signal one as is, the generic one plus `/v1/traces`). */
export function otlpTracesUrl(env: NodeJS.ProcessEnv): string {
  if (present(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)) return env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!.trim();
  if (present(env.OTEL_EXPORTER_OTLP_ENDPOINT)) return `${env.OTEL_EXPORTER_OTLP_ENDPOINT!.trim().replace(/\/+$/, '')}/v1/traces`;
  return 'http://localhost:4318/v1/traces';
}

/**
 * At most one warning per `key` a minute, saying how many were held back: a
 * collector that is down fails every export, and the log should say so once
 * a minute, not every five seconds.
 */
const warned = new Map<string, { at: number; suppressed: number }>();
function warnLimited(key: string, fields: Record<string, unknown>, msg: string): void {
  const now = Date.now();
  const last = warned.get(key);
  if (last && now - last.at < 60_000) {
    last.suppressed++;
    return;
  }
  warned.set(key, { at: now, suppressed: 0 });
  coreLogger.warn({ ...fields, ...(last?.suppressed ? { suppressedSinceLast: last.suppressed } : {}) }, msg);
}

let enabled = false;
let trustInbound = false;
let propagateOutbound = false;
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
  if (config.error) coreLogger.error({ reason: config.reason }, config.error);
  if (!config.enabled) {
    if (!config.error) coreLogger.debug({ reason: config.reason }, 'Tracing off');
    return config;
  }
  for (const warning of config.warnings) coreLogger.warn(warning);
  const [sdk, { AsyncLocalStorageContextManager }, { W3CTraceContextPropagator }, resources] =
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
    error: (msg, ...args) => warnLimited(`diag:${msg}`, { args }, `OpenTelemetry: ${msg}`),
    warn: (msg, ...args) => warnLimited(`diag:${msg}`, { args }, `OpenTelemetry: ${msg}`),
    info: () => {},
    debug: () => {},
    verbose: () => {},
  }, DiagLogLevel.WARN);

  // Everything is read from `env` and passed explicitly, so the exporter,
  // batching, sampler and resource follow the same variables that decided
  // tracing is on. (The exporter still merges headers it finds in
  // `process.env`; the ones from `env` win.)
  let spanProcessors = options.spanProcessors;
  if (!spanProcessors) {
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const timeout = envNumber(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT ?? env.OTEL_EXPORTER_OTLP_TIMEOUT);
    const compression = (env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION ?? env.OTEL_EXPORTER_OTLP_COMPRESSION ?? '').trim().toLowerCase();
    const exporter = new OTLPTraceExporter({
      url: otlpTracesUrl(env),
      headers: { ...keyValues(env.OTEL_EXPORTER_OTLP_HEADERS), ...keyValues(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) },
      ...(timeout !== undefined ? { timeoutMillis: timeout } : {}),
      ...(compression === 'gzip' || compression === 'none' ? { compression: compression as never } : {}),
    });
    spanProcessors = [new sdk.BatchSpanProcessor(exporter, {
      maxExportBatchSize: envNumber(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE) ?? 512,
      maxQueueSize: envNumber(env.OTEL_BSP_MAX_QUEUE_SIZE) ?? 2048,
      scheduledDelayMillis: envNumber(env.OTEL_BSP_SCHEDULE_DELAY) ?? 5000,
      exportTimeoutMillis: envNumber(env.OTEL_BSP_EXPORT_TIMEOUT) ?? 30_000,
    })];
  }
  // `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` win over the defaults here.
  const resource = resources.defaultResource()
    .merge(resources.resourceFromAttributes({
      'service.name': 'octipus',
      'service.version': getAppVersion(),
      ...keyValues(env.OTEL_RESOURCE_ATTRIBUTES),
      ...(present(env.OTEL_SERVICE_NAME) ? { 'service.name': env.OTEL_SERVICE_NAME!.trim() } : {}),
    }));
  const tracerProvider = new sdk.BasicTracerProvider({ resource, spanProcessors, sampler: samplerFromEnv(sdk, env) });

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(tracerProvider);
  provider = tracerProvider;
  trustInbound = config.trustInbound;
  propagateOutbound = config.propagateOutbound;
  enabled = true;
  coreLogger.info({ reason: config.reason }, 'Tracing on: exporting spans over OTLP');
  return config;
}

/**
 * `OTEL_TRACES_SAMPLER` / `_ARG` (default `parentbased_always_on`). An
 * unknown sampler is said and the default used.
 */
function samplerFromEnv(sdk: typeof import('@opentelemetry/sdk-trace-base'), env: NodeJS.ProcessEnv): import('@opentelemetry/sdk-trace-base').Sampler {
  const name = (env.OTEL_TRACES_SAMPLER ?? 'parentbased_always_on').trim().toLowerCase();
  const arg = envNumber(env.OTEL_TRACES_SAMPLER_ARG);
  const ratio = arg !== undefined && arg <= 1 ? arg : 1;
  switch (name) {
    case 'always_on': return new sdk.AlwaysOnSampler();
    case 'always_off': return new sdk.AlwaysOffSampler();
    case 'traceidratio': return new sdk.TraceIdRatioBasedSampler(ratio);
    case 'parentbased_always_off': return new sdk.ParentBasedSampler({ root: new sdk.AlwaysOffSampler() });
    case 'parentbased_traceidratio': return new sdk.ParentBasedSampler({ root: new sdk.TraceIdRatioBasedSampler(ratio) });
    case 'parentbased_always_on': return new sdk.ParentBasedSampler({ root: new sdk.AlwaysOnSampler() });
    default:
      coreLogger.warn({ sampler: name }, 'OTEL_TRACES_SAMPLER is not one this build knows: using parentbased_always_on');
      return new sdk.ParentBasedSampler({ root: new sdk.AlwaysOnSampler() });
  }
}

/** How long shutdown waits for the last spans before giving up on them. */
export const SHUTDOWN_FLUSH_MS = 1500;

/**
 * Flush and stop the exporter. Called at shutdown; a no-op while tracing is
 * off. Bounded by `timeoutMs`: a collector that is down makes the exporter
 * retry with backoff for seconds, and shutdown has a watchdog of its own that
 * must not be the one to end the process. Spans not out by then are dropped.
 */
export async function shutdownTracing(timeoutMs = SHUTDOWN_FLUSH_MS): Promise<void> {
  if (!provider) return;
  const current = provider;
  provider = null;
  enabled = false;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    const outcome = await Promise.race([current.shutdown().then(() => 'done' as const), timedOut]);
    if (outcome === 'timeout') coreLogger.warn({ timeoutMs }, 'Spans not flushed at shutdown: the collector did not answer in time');
  } catch (err) {
    coreLogger.warn({ err }, 'Flushing spans at shutdown failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Tests only: drop the registered globals so the next `initTracing` starts clean. */
export async function resetTracingForTests(): Promise<void> {
  if (provider) await provider.shutdown();
  provider = null;
  enabled = false;
  trustInbound = false;
  propagateOutbound = false;
  warned.clear();
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
    // A tracing bug must never break a request or a turn, but it is said.
    warnLimited('span-creation', { err }, 'Span creation failed; continuing without the span');
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
 * Add the active span's `traceparent` to outgoing request headers, when the
 * operator opted in (`OCTIPUS_TRACE_PROPAGATE_OUTBOUND=true`): by default no
 * trace id leaves for a third-party host. `tracestate` is never sent: it can
 * hold whatever an inbound caller put there. A `traceparent` header already
 * there (one an operator configured on purpose) is kept.
 */
export function injectTraceHeaders(headers: Record<string, string>): Record<string, string> {
  if (!enabled || !propagateOutbound) return headers;
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  const traceparent = carrier.traceparent;
  if (traceparent && !Object.keys(headers).some((k) => k.toLowerCase() === 'traceparent')) headers.traceparent = traceparent;
  return headers;
}

const headerGetter = {
  get: (carrier: Headers, key: string) => carrier.get(key) ?? undefined,
  keys: (carrier: Headers) => [...carrier.keys()],
};

/** Probes and scrapes: polled every few seconds, they would drown every real trace. */
const UNTRACED_PATH = /^(?:\/api)?\/(?:health|metrics)(?:\/|$)/;

/** Server spans whose request matched a route template (`setHttpRoute`). */
const routedSpans = new WeakSet<Span>();

/**
 * The SERVER span of one inbound HTTP request. A caller's W3C `traceparent`
 * is continued only when the operator trusts what sits in front of the
 * server (`OCTIPUS_TRACE_TRUST_INBOUND=true`): an untrusted caller could
 * otherwise force sampling, switch it off for their own requests, or splice
 * spans into a trace of their choosing. Untrusted, the request starts a new
 * trace with a link to the caller's context. A request that matched a route
 * records the template (`http.route`) and not its path, which can hold a
 * token (`/api/devices/push-token/:token`); an unmatched one records its path
 * through the log redactor. The query string is never recorded. Health and
 * metrics requests are not traced. `statusOf` reads the response status once
 * `fn` has answered.
 */
export async function withInboundHttpSpan<T>(request: Request, fn: () => Promise<T>, statusOf: (result: T) => number | undefined): Promise<T> {
  if (!enabled) return fn();
  const url = new URL(redactUrlForLog(request.url));
  if (UNTRACED_PATH.test(url.pathname)) return fn();
  const remote = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, request.headers, headerGetter));
  const validRemote = remote && isSpanContextValid(remote) ? remote : undefined;
  let span: Span;
  try {
    span = trace.getTracer(TRACER_NAME).startSpan(request.method, {
      kind: SpanKind.SERVER,
      attributes: toAttributes({ 'http.request.method': request.method, 'url.scheme': url.protocol.replace(/:$/, '') }),
      ...(validRemote && !trustInbound ? { links: [{ context: validRemote }] } : {}),
    }, validRemote && trustInbound ? trace.setSpanContext(ROOT_CONTEXT, validRemote) : ROOT_CONTEXT);
  } catch (err) {
    warnLimited('span-creation', { err }, 'Span creation failed; continuing without the span');
    return fn();
  }
  const handle = wrap(span);
  try {
    const result = await handle.run(fn);
    const status = statusOf(result);
    if (status !== undefined) {
      handle.setAttributes({ 'http.response.status_code': status });
      if (status >= 500) handle.failWith(String(status));
    }
    return result;
  } catch (error) {
    handle.fail(error);
    throw error;
  } finally {
    if (!routedSpans.has(span)) handle.setAttributes({ 'url.path': url.pathname });
    handle.end();
  }
}

/** Name the active SERVER span after the matched route template (`POST /api/sessions/:id`). */
export function setHttpRoute(method: string, route: string): void {
  if (!enabled) return;
  const span = trace.getActiveSpan();
  if (!span) return;
  routedSpans.add(span);
  span.setAttribute('http.route', route);
  span.updateName(`${method} ${route}`);
}

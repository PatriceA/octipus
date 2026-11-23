/**
 * Tracing off costs nothing at start: the SDK packages are never imported.
 * Each is replaced by a module that throws when loaded, so any import of one
 * fails this suite.
 */
import { describe, expect, test, vi } from 'vitest';

vi.mock('@opentelemetry/sdk-trace-base', () => { throw new Error('sdk-trace-base loaded while tracing is off'); });
vi.mock('@opentelemetry/context-async-hooks', () => { throw new Error('context-async-hooks loaded while tracing is off'); });
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => { throw new Error('OTLP exporter loaded while tracing is off'); });
vi.mock('@opentelemetry/resources', () => { throw new Error('resources loaded while tracing is off'); });

import { trace } from '@opentelemetry/api';
import {
  failActiveSpan, initTracing, injectTraceHeaders, isTracingEnabled, setActiveSpanAttributes, startSpan,
  withInboundHttpSpan, withSpan,
} from './tracing';

describe('tracing off', () => {
  test.each([
    ['nothing configured', {}],
    ['OTEL_SDK_DISABLED over an endpoint', { OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }],
    ['OTEL_TRACES_EXPORTER=none over an endpoint', { OTEL_TRACES_EXPORTER: 'none', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }],
  ])('%s: no SDK, no provider, helpers pass through', async (_label, env) => {
    const config = await initTracing({ env: env as NodeJS.ProcessEnv });
    expect(config.enabled).toBe(false);
    expect(isTracingEnabled()).toBe(false);
    const status = await withInboundHttpSpan(new Request('http://localhost/x'), async () => 204, (s) => s);
    expect(status).toBe(204);
    expect(await withSpan('agent.run', {}, async (span) => {
      span.setAttributes({ 'octipus.run_id': 'r' });
      setActiveSpanAttributes({ 'octipus.topic': 't' });
      failActiveSpan(new Error('x'));
      return trace.getActiveSpan();
    })).toBeUndefined();
    const manual = startSpan('chat m');
    expect(manual.run(() => 7)).toBe(7);
    manual.end();
    expect(injectTraceHeaders({ a: 'b' })).toEqual({ a: 'b' });
  });
});

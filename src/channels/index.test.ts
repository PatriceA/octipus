import { describe, expect, it } from 'vitest';
import { eventSessionId } from './index';

describe('eventSessionId', () => {
  it('does not drop a channel event because the CLI reported its own vendor session id', () => {
    // Before the fix this read data.sessionId first, and for CLI thought
    // events that field holds the vendor (Claude/Codex) session id — so a
    // stale/foreign value there used to shadow the real octipus session id
    // and silently drop the event.
    const event = { sessionId: 'octipus-1', data: { sessionId: 'vendor-9', status: 'running' } };
    expect(eventSessionId(event)).toBe('octipus-1');
  });

  it('falls back to data.context.sessionId when the event has no top-level sessionId', () => {
    const event = { data: { context: { sessionId: 'octipus-2' } } };
    expect(eventSessionId(event)).toBe('octipus-2');
  });
});

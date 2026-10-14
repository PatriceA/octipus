import { describe, expect, it } from 'vitest';
import { eventSessionId, imageConverter } from './index';

describe('eventSessionId', () => {
  const agents = new Map([['agent-1', { getContext: () => ({ sessionId: 'octipus-1' }) }]]);
  const getAgent = (id: string) => agents.get(id);

  it('is the session of the agent that emitted the event', () => {
    // An AgentEvent has no session id of its own: reading one off the event
    // (or its data.context) matched nothing, so the channel never showed a
    // tool emoji or kept its typing indicator alive on agent events.
    expect(eventSessionId({ agentId: 'agent-1' }, getAgent)).toBe('octipus-1');
  });

  it('ignores the vendor session id a CLI event carries in its data', () => {
    const event = { agentId: 'agent-1', type: 'thought' as const, data: { sessionId: 'vendor-9' }, timestamp: new Date() };
    expect(eventSessionId(event, getAgent)).toBe('octipus-1');
  });

  it('is undefined once the agent is gone', () => {
    expect(eventSessionId({ agentId: 'gone' }, getAgent)).toBeUndefined();
  });
});

describe('imageConverter', () => {
  it('prefers magick, never System32 convert on Windows', () => {
    expect(imageConverter('win32', () => 'C:/IM/magick.exe')).toBe('C:/IM/magick.exe');
    expect(imageConverter('win32', () => null)).toBeNull();
    expect(imageConverter('linux', () => null)).toBe('convert');
  });
});

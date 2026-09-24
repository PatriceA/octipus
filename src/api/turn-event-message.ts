import type { TurnEvent, TurnResult } from '@/core/agent/service';

/** Legacy webchat still consumes a top-level chat_response, not a turn_event wrapper. */
export function turnEventMessage(event: TurnEvent) {
  if (event.type === 'chat_response') {
    const result = event.data as TurnResult;
    return { ...result, type: 'chat_response', sessionId: event.sessionId };
  }
  return { type: 'turn_event', event: event.type, sessionId: event.sessionId, data: event.data, timestamp: event.timestamp };
}

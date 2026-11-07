import { sql } from 'drizzle-orm';
import { getRunContext } from '@/core/run-context';
import { messages, type NewMessage } from '../schema/messages';

/** Apply before pagination/counting, so hidden coordination never displaces chat history. */
export const visibleMessages = sql`coalesce(${messages.metadata}->>'visibility','visible') <> 'internal'`;

export function withMessageVisibility(data: NewMessage): NewMessage {
  const run = getRunContext();
  if (run?.sessionId !== data.sessionId) return data;
  if (run.companionBriefing || (run.companionObservation && data.role === 'user')) {
    return { ...data, metadata: { ...data.metadata, visibility: 'internal' } };
  }
  return data;
}

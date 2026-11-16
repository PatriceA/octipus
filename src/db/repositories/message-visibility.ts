import { sql } from 'drizzle-orm';
import { getRunContext } from '@/core/run-context';
import { messages, type NewMessage } from '../schema/messages';

/** Apply before pagination/counting, so hidden coordination never displaces chat history. */
export const visibleMessages = sql`coalesce(${messages.metadata}->>'visibility','visible') <> 'internal'`;

export function withMessageVisibility(data: NewMessage): NewMessage {
  const run = getRunContext();
  if (run?.sessionId !== data.sessionId) return data;
  // A background check-in is private: its prompt, tool traffic and final text
  // stay out of the chat. Only a report the server delivered is shown.
  if (run.companionBriefing || (run.companionObservation && !data.metadata?.companionReport)) {
    return { ...data, metadata: { ...data.metadata, visibility: 'internal' } };
  }
  return data;
}

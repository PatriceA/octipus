import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { sessionGeneration } from '@/db/schema/sessions';
import type { AgentContext } from '@/core/types';
import { guardOutput, stripSwarmScaffolding } from './output-guard';
import { canActInSession } from '@/core/rooms/access';

const delivered = new WeakMap<AgentContext, Set<string>>();
const pending = new WeakMap<AgentContext, Promise<unknown>>();

/** Persist before publishing; a cleared conversation must not regain old updates. */
export function saveProgressMessage(message: string, context: AgentContext, generation?: string) {
  const next = (pending.get(context) ?? Promise.resolve()).catch(() => {}).then(() => save(message, context, generation));
  pending.set(context, next);
  return next;
}

async function save(message: string, context: AgentContext, generation?: string) {
  const flags = Array.isArray(context.metadata.inputGuardFlags)
    ? context.metadata.inputGuardFlags.filter((flag): flag is string => typeof flag === 'string') : [];
  const text = stripSwarmScaffolding(guardOutput(message, flags).response).trim();
  if (!text || delivered.get(context)?.has(text)) return null;
  const session = await sessionRepository.findById(context.sessionId);
  if (!session || !(await canActInSession(session, context.userId, 'requester'))) return null;
  const expected = generation ?? (typeof context.metadata.sessionGeneration === 'string'
    ? context.metadata.sessionGeneration : sessionGeneration(session.context));
  const row = await messageRepository.createForGeneration({
    sessionId: context.sessionId, agentId: context.id, role: 'assistant', content: text,
    metadata: { kind: 'progress' },
  }, expected);
  if (!row) return null;
  const seen = delivered.get(context) ?? new Set<string>();
  seen.add(text);
  delivered.set(context, seen);
  return { message: text, messageId: row.id, createdAt: row.createdAt.toISOString() };
}

import { sessionRepository } from '@/db/repositories/session-repository';
import { skillSelectionRepository, type SkillMode } from '@/db/repositories/skill-selection-repository';
import { getSkillRegistry } from './registry';
import { getSkillModes } from './selection';

const HELP = 'Skills: /skills [list] | /skills <id or name> always|session|auto | /skills <id or name> auto --global\nAlways is your default for all chats. Session and auto override it only in this chat. Changes apply to new turns and agents.';

/** Shared by the web/channel chat and both terminal clients. */
export async function handleSkillSelectionCommand(userId: string, sessionId: string | undefined, rawArgs: string): Promise<string> {
  // Channel clients use ids like 'telegram-123'; only uuids name a session row.
  if (sessionId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) sessionId = undefined;
  const args = rawArgs.trim();
  if (args === 'help' || args === '--help') return HELP;
  const global = args.endsWith(' --global');
  const input = global ? args.slice(0, -9).trim() : args;
  const match = /^(.*?)\s+(always|session|auto|automatic)$/i.exec(input);
  if (input && input !== 'list' && !match) return HELP;
  // Never allow a command to write another user's session, even with a guessed id.
  if (sessionId) {
    const session = await sessionRepository.findById(sessionId);
    if (!session || session.userId !== userId) return 'Session not found. Start or select a chat first.';
  }
  const available = await getSkillRegistry().getAll(userId === 'system' ? undefined : userId);
  const modes = await getSkillModes(userId, global ? undefined : sessionId);
  if (!match) {
    const rows = available.map(skill => `${skill.id} — ${skill.name} [${modes.get(skill.id) ?? 'automatic'}]`);
    const visible = new Set(available.map(skill => skill.id));
    for (const [id, mode] of modes) if (!visible.has(id)) rows.push(`${id} — unavailable [${mode}]`);
    return `${HELP}\n\n${rows.length ? rows.join('\n') : 'No skills available.'}`;
  }
  const name = match[1].replace(/^['"]|['"]$/g, '');
  const mode: SkillMode = match[2].toLowerCase() === 'auto' ? 'automatic' : match[2].toLowerCase() as SkillMode;
  if (mode === 'session' && (global || !sessionId)) return 'This session requires an active chat and cannot use --global.';
  const found = available.filter(skill => skill.id === name);
  if (!found.length) found.push(...available.filter(skill => skill.name.toLowerCase() === name.toLowerCase()));
  if (found.length > 1) return 'More than one skill has that name. Use the id from /skills.';
  const skillId = found[0]?.id ?? (mode === 'automatic' && modes.has(name) ? name : undefined);
  if (!skillId) return `Skill not found: ${name}. Use /skills to list available ids.`;
  await skillSelectionRepository.set(userId, skillId, mode, global ? undefined : sessionId);
  return `${found[0]?.name ?? skillId}: ${mode === 'always' ? 'Always (all your chats)' : mode === 'session' ? 'This session' : global || !sessionId ? 'Automatic (default)' : 'Automatic (this session)'}. Applies to new turns and agents.`;
}

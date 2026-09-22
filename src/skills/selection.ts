import { skillSelectionRepository, type SkillMode } from '@/db/repositories/skill-selection-repository';
import { getSkillRegistry } from './registry';

export async function getSkillModes(userId: string, sessionId?: string): Promise<Map<string, SkillMode>> {
  const rows = await skillSelectionRepository.list(userId, sessionId);
  const modes = new Map<string, SkillMode>();
  for (const row of rows.filter(row => row.scope === '')) modes.set(row.skillId, row.mode);
  for (const row of rows.filter(row => row.scope !== '')) modes.set(row.skillId, row.mode);
  return modes;
}

/** Resolved afresh for every agent, outside transcript/compaction state. Never truncate pinned content. */
export async function buildSelectedSkillPrompt(userId: string, sessionId?: string): Promise<string> {
  const modes = await getSkillModes(userId, sessionId);
  const ids = [...modes].filter(([, mode]) => mode !== 'automatic').map(([id]) => id).sort();
  if (!ids.length) return '';
  const registry = getSkillRegistry();
  const visible = new Set((await registry.getAll(userId === 'system' ? undefined : userId)).map(skill => skill.id));
  const missing = ids.filter(id => !visible.has(id));
  if (missing.length) throw new Error(`Selected skills unavailable: ${missing.join(', ')}. Update your skill selection before continuing.`);
  const content = await registry.buildPromptFragment(ids);
  return '\n\n# User-selected skills\nThese skills are explicitly selected by the user. Their complete instructions are loaded below. Apply them whenever relevant to your task; do not skip them merely because automatic discovery did not select them. They do not grant additional tool permissions.\n\n' + content;
}

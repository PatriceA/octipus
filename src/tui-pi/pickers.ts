/**
 * What the pickers list, read from the gateway's command results.
 *
 * Sessions come as data (`/sessions` sends `data` rows). Skills do not: the
 * gateway's `/skills` answers with text, one `<id> — <name> [<mode>]` row per
 * skill under a help paragraph (`src/skills/selection-command.ts`). Those
 * rows are read here; a reply in which none can be read is returned as
 * `unreadable` so the picker shows the server's text instead of an empty list.
 *
 * Models come as data from the gateway's `/model` (the caller's session
 * override and the enabled models they may use, `src/core/commands/model.ts`).
 */
import type { FuzzyListItem } from '@/tui-kit/fuzzy-list';

export interface SessionRow { id: string; title: string; updatedAt: string; messages: number; channel?: string }

export const isSessionRow = (v: unknown): v is SessionRow => {
  const r = v as SessionRow | null;
  return !!r && typeof r.id === 'string' && typeof r.title === 'string';
};

export function sessionItems(rows: readonly SessionRow[], current: string): FuzzyListItem<SessionRow>[] {
  return rows.map(row => ({
    value: row,
    label: `${row.title || '(untitled)'}${row.id === current ? '  (this session)' : ''}`,
    description: `${row.updatedAt.slice(0, 16).replace('T', ' ')} · ${row.messages ?? 0} msg`,
    search: `${row.title} ${row.id} ${row.channel ?? ''}`,
  }));
}

export function sessionPreview(row: SessionRow): string {
  return [row.title, `Session ${row.id}`, `Updated ${row.updatedAt.slice(0, 16).replace('T', ' ')} · ${row.messages ?? 0} messages${row.channel ? ` · from ${row.channel}` : ''}`, 'Enter resumes it here.'].join('\n');
}

export type SkillMode = 'always' | 'session' | 'automatic';
export interface SkillRow { id: string; name: string; mode: string; available: boolean }

const SKILL_ROW = /^(\S+) — (.+) \[([^\]]+)\]$/;

export function parseSkillList(text: string): { rows: SkillRow[] } | { unreadable: string } {
  const rows: SkillRow[] = [];
  for (const line of text.split('\n')) {
    const match = SKILL_ROW.exec(line.trim());
    if (match) rows.push({ id: match[1] as string, name: match[2] as string, mode: match[3] as string, available: match[2] !== 'unavailable' });
  }
  if (rows.length || /No skills available\./.test(text)) return { rows };
  return { unreadable: text };
}

export function skillItems(rows: readonly SkillRow[]): FuzzyListItem<SkillRow>[] {
  return rows.map(row => ({ value: row, label: row.name, description: `[${row.mode}] ${row.id}`, search: `${row.name} ${row.id} ${row.mode}` }));
}

export const SKILL_MODES: ReadonlyArray<{ mode: SkillMode; label: string; description: string }> = [
  { mode: 'automatic', label: 'Automatic', description: 'Used when the agent judges it relevant (default)' },
  { mode: 'always', label: 'Always', description: 'In every chat of yours' },
  { mode: 'session', label: 'This session', description: 'Always, in this chat only' },
];

/** The `/skills` arguments that set a skill's mode for this session. */
export function skillCommand(skill: SkillRow, mode: SkillMode): string {
  return `${skill.id} ${mode === 'automatic' ? 'auto' : mode}`;
}

export interface ModelRow { name: string; modelId: string; provider: string; isDefault: boolean }
export interface ModelList { current: string | null; models: ModelRow[] }

export const isModelList = (v: unknown): v is ModelList => {
  const r = v as ModelList | null;
  return !!r && Array.isArray(r.models) && r.models.every(m => !!m && typeof m.name === 'string' && typeof m.modelId === 'string');
};

/** What a model picker entry does: switch to a model, or drop the override. */
export type ModelChoice = { kind: 'model'; model: ModelRow } | { kind: 'clear' };

export function modelItems(list: ModelList): FuzzyListItem<ModelChoice>[] {
  const items: FuzzyListItem<ModelChoice>[] = list.models.map(model => ({
    value: { kind: 'model', model },
    label: `${model.name}${model.name === list.current ? '  (this session)' : ''}${model.isDefault ? '  (default)' : ''}`,
    description: `${model.modelId} · ${model.provider}`,
    search: `${model.name} ${model.modelId} ${model.provider}`,
  }));
  if (list.current) items.unshift({ value: { kind: 'clear' }, label: 'Configured default', description: `Drop this session's choice (${list.current})`, search: 'default clear reset' });
  return items;
}

/** The `/model` argument an entry sends. */
export function modelCommand(choice: ModelChoice): string {
  return choice.kind === 'clear' ? 'clear' : choice.model.name;
}

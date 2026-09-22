import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type Mode = 'automatic' | 'always' | 'session';
type SkillChoice = { id: string; name: string; description: string; mode: Mode; available: boolean };

/** Shared control for personal defaults and the active conversation's overrides. */
export function SkillUsage({ sessionId, running = false }: { sessionId?: string; running?: boolean }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['skill-usage', sessionId ?? 'defaults'],
    queryFn: () => api.get<{ skills: SkillChoice[] }>(`/skills/usage${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`),
    enabled: open,
  });
  const save = useMutation({
    mutationFn: ({ skillId, mode }: { skillId: string; mode: Mode }) => api.patch('/skills/usage', { skillId, mode, sessionId }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['skill-usage'] }); },
  });
  const skills = query.data?.skills ?? [];
  const pinned = skills.filter(skill => skill.mode !== 'automatic').length;
  return (
    <section className="border border-outline-variant rounded-xs text-sm">
      <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}
        className="w-full px-3 py-2 text-left text-on-surface hover:bg-surface-container">
        {open ? '▾' : '▸'} Skills {query.data ? `· ${pinned} selected` : ''}
      </button>
      {open && <div className="px-3 pb-3 space-y-3">
        <p className="text-xs text-on-surface-variant">
          {sessionId
            ? 'Always sets your default for all chats. This session loads the skill only here. Automatic overrides your default for this chat. Manage defaults on the Skills page.'
            : 'Always loads the full skill in all your chats. Automatic lets the agent select it as needed. Choose skills for a single session from its chat.'}
          {' '}Changes apply to new turns and agents. Selected skills also apply to subagents when relevant.
        </p>
        {running && <p className="text-xs text-on-surface-variant">A turn is running. Its current agents keep their existing selection.</p>}
        <input aria-label="Filter skill selection" value={search} onChange={event => setSearch(event.target.value)}
          placeholder="Find a skill…" className="w-full px-2 py-1.5 border border-outline-variant bg-surface rounded-xs" />
        {query.isPending && <p role="status">Loading skills…</p>}
        {query.isError && <p role="alert" className="text-error">{query.error.message} <button type="button" onClick={() => void query.refetch()}>Retry</button></p>}
        {save.isError && <p role="alert" className="text-error">{save.error.message}</p>}
        <div className="max-h-72 overflow-y-auto divide-y divide-outline-variant">
          {skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase())).map(skill => (
            <div key={skill.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <label htmlFor={`skill-mode-${skill.id}`} className="font-medium">{skill.name}{!skill.available && ' (unavailable)'}</label>
                <p className="text-xs text-on-surface-variant line-clamp-2">{skill.description}</p>
              </div>
              <select id={`skill-mode-${skill.id}`} value={skill.mode} disabled={save.isPending}
                onChange={event => save.mutate({ skillId: skill.id, mode: event.target.value as Mode })}
                className="shrink-0 border border-outline-variant bg-surface px-2 py-1.5 rounded-xs">
                <option value="automatic">Automatic</option>
                <option value="always" disabled={!skill.available}>Always</option>
                {sessionId && <option value="session" disabled={!skill.available}>This session</option>}
              </select>
            </div>
          ))}
          {query.data && !skills.length && <p className="py-2 text-on-surface-variant">No skills available.</p>}
        </div>
      </div>}
    </section>
  );
}

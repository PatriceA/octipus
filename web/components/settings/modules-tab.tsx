'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Boxes } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { type ModulesResponse, type ModuleView, modulesKey, useModules } from '@/lib/modules';
import { cn } from '@/lib/utils';

/**
 * Settings → Modules (docs/MODULES.md): the parts of Octipus that are not
 * everyone's. A module that is off is gone for everyone, agents included:
 * no pages, tools, background jobs or API. Its data stays, and turning it on
 * again brings everything back. Admins switch; everyone else reads.
 */
export function ModulesTab() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const list = useModules();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modules = list.data?.modules ?? [];
  const titles = new Map(modules.map((m) => [m.id, m.title]));

  const toggle = async (m: ModuleView) => {
    setBusy(m.id);
    setError(null);
    try {
      const next = await api.put<ModulesResponse>(`/modules/${encodeURIComponent(m.id)}`, { on: !m.on });
      qc.setQueryData(modulesKey, next);
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(null);
  };

  return (
    <div className="space-y-5 font-mono" data-testid="settings-modules">
      <div className="space-y-1">
        <h2 className="section-label">modules</h2>
        <p className="text-[12px] text-on-surface-variant leading-relaxed">
          The core (chat, agents, tasks, notes, documents, models, connectors, settings, backups) is always on. A module
          that is off is gone for everyone, agents included: no menu entry, no tool, no background job. Its data stays
          and comes back when it is turned on again.
        </p>
      </div>
      {error && <p role="alert" className="text-[12px] text-error">! {error}</p>}
      {list.error && <p role="alert" className="text-[12px] text-error">! {(list.error as Error).message}</p>}
      {list.isLoading && <p className="text-[12px] text-on-surface-variant">loading…</p>}
      <ul className="space-y-3">
        {modules.map((m) => {
          const adds = [
            m.pages.length > 0 && `pages ${m.pages.join(', ')}`,
            m.tools.length > 0 && `agent tools ${m.tools.join(', ')}`,
            m.jobs.length > 0 && `background ${m.jobs.join(', ')}`,
          ].filter(Boolean);
          const blockers = m.requiredBy.filter((id) => modules.find((o) => o.id === id)?.on);
          return (
            <li key={m.id} className="term-frame rounded-xs p-3 space-y-1.5 text-[12px]" data-testid={`module-${m.id}`}>
              <label className={cn('flex items-start gap-2', user?.isAdmin ? 'cursor-pointer' : 'cursor-default')}>
                <input
                  type="checkbox"
                  className="mt-0.5 accent-primary"
                  checked={m.on}
                  disabled={!user?.isAdmin || busy !== null || (m.on && blockers.length > 0)}
                  onChange={() => void toggle(m)}
                  aria-label={`${m.title}: ${m.on ? 'on' : 'off'}`}
                />
                <span className="space-y-0.5">
                  <span className="flex items-center gap-2 text-on-surface">
                    <Boxes className="w-3.5 h-3.5 text-on-surface-variant" />
                    {m.title}
                    <span className={cn('text-[11px]', m.on ? 'text-tertiary' : 'text-on-surface-variant')}>{m.on ? 'on' : 'off'}</span>
                  </span>
                  <span className="block text-on-surface-variant">{m.description}</span>
                </span>
              </label>
              {adds.length > 0 && <p className="text-[11px] text-on-surface-variant pl-6">adds {adds.join(' · ')}</p>}
              {m.dependsOn.length > 0 && <p className="text-[11px] text-on-surface-variant pl-6">needs {m.dependsOn.map((id) => titles.get(id) ?? id).join(', ')}</p>}
              {blockers.length > 0 && <p className="text-[11px] text-on-surface-variant pl-6">needed by {blockers.map((id) => titles.get(id) ?? id).join(', ')}: turn that off first</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

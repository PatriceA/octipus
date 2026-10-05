'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/ui/page-header';
import { api } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import type { MyWorkResponse } from '../../../src/shared/types';

const PRIORITY = ['', 'low', 'medium', 'high'];

/**
 * "My work" (coworking spec §9.3): the open tasks assigned to me, in every
 * space I belong to and in my personal workspaces, grouped by space. A task
 * opens on its board, in its workspace.
 */
export default function MyWorkPage() {
  const router = useRouter();
  const { switchWorkspace, workspaces } = useWorkspace();
  const workQ = useQuery({
    queryKey: ['me', 'work'],
    queryFn: () => api.get<MyWorkResponse>('/me/work'),
  });
  const groups = workQ.data?.groups ?? [];
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);

  const open = (workspaceId: string | null) => {
    const target = workspaceId ?? workspaces.find((w) => w.isDefault)?.id;
    if (target) switchWorkspace(target);
    router.push('/tasks');
  };

  return (
    <div className="space-y-6 max-w-4xl font-mono">
      <PageHeader title="my work" description="open tasks assigned to you, across your spaces" />
      {workQ.error && (
        <div role="alert" className="px-3 py-2 border border-error/40 bg-error/10 rounded-xs text-[12px] text-error">! {(workQ.error as Error).message}</div>
      )}
      {workQ.isLoading && <p className="text-on-surface-variant text-[12px]">loading…</p>}
      {!workQ.isLoading && total === 0 && (
        <p className="text-on-surface-variant text-[12px]" data-testid="my-work-empty">nothing assigned to you right now.</p>
      )}
      {groups.map((g) => (
        <section key={g.workspaceId ?? 'personal'} aria-label={g.name} className="space-y-2" data-testid="my-work-group">
          <h2 className="section-label">{g.kind === 'shared' ? `${g.name}` : `${g.name} (personal)`} · {g.tasks.length}</h2>
          <div className="term-frame rounded-xs divide-y divide-outline-variant/20">
            {g.tasks.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => open(g.workspaceId)}
                className="w-full flex items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-surface-container-high cursor-pointer"
                data-testid="my-work-task"
              >
                <span className="text-on-surface flex-1 min-w-0 truncate">{t.title}</span>
                {t.priority > 0 && <span className="text-[11px] text-tertiary">{PRIORITY[t.priority]}</span>}
                <span className="text-[11px] text-on-surface-variant">{t.status.replace('_', ' ')}</span>
                {t.dueAt && <span className="text-[11px] text-on-surface-variant">due {new Date(t.dueAt).toLocaleDateString()}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

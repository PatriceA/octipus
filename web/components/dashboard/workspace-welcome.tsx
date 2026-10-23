'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { CompanionAvatar } from '@/components/companion/companion-avatar';
import { api } from '@/lib/api';
import { usePageOn } from '@/lib/modules';
import { useWorkspace } from '@/lib/workspace-context';
import type { ResolvedPersona } from '../../../src/core/personas/types';

/** Start with the person's work; operational details remain below. */
export function WorkspaceWelcome() {
  const { activeWorkspace } = useWorkspace();
  const pageOn = usePageOn();
  const { data: persona } = useQuery({
    queryKey: ['persona', 'me'],
    queryFn: () => api.get<Pick<ResolvedPersona, 'name' | 'appearance'>>('/persona'),
  });
  const shared = activeWorkspace?.kind === 'shared' || activeWorkspace?.kind === 'remote';
  return (
    <section className="flex flex-col sm:flex-row sm:items-center gap-5 rounded-2xl border border-outline-variant/60 bg-surface-container-low p-5 sm:p-6" aria-label="Start work">
      <div className="self-start rounded-2xl bg-companion-paper p-2 shrink-0">
        <CompanionAvatar size={88} appearance={persona?.appearance} />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-primary mb-1">{persona?.name || 'Octipus'} · your companion</p>
        <h2 className="text-xl font-semibold">What shall we work on?</h2>
        <p className="mt-2 text-sm text-on-surface-variant">Bring an idea, research a question, or pick up where you left off.</p>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <Link href="/chat" className="rounded-full bg-primary px-4 py-2 font-semibold text-on-primary hover:bg-primary-fixed-dim">Work on a project</Link>
          {shared && <Link href="/rooms" className="rounded-full border border-outline-variant px-4 py-2 hover:border-primary">Work together</Link>}
          {pageOn('/research') && <Link href="/research" className="text-primary underline underline-offset-4">Research a question</Link>}
          <Link href="/tasks" className="text-primary underline underline-offset-4">Plan follow-up tasks</Link>
          {pageOn('/persona') && <Link href="/persona" className="text-on-surface-variant underline underline-offset-4">Make it yours</Link>}
        </div>
      </div>
    </section>
  );
}

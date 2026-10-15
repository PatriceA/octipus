'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';

/** Navigation only: changing views never publishes or copies a conversation. */
export function WorkNavigation() {
  const pathname = usePathname();
  const { activeWorkspace } = useWorkspace();
  const { user } = useAuth();
  const requestedJob = useSearchParams().get('job');
  const [research, setResearch] = useState<{ owner?: string; job: string | null }>({ owner: user?.id, job: null });
  if (pathname === '/research' && requestedJob && (research.job !== requestedJob || research.owner !== user?.id)) {
    setResearch({ owner: user?.id, job: requestedJob });
  }
  const remote = activeWorkspace?.kind === 'remote';
  const shared = activeWorkspace?.kind === 'shared' || remote;
  const items = [
    ...(!remote ? [{ href: '/chat', label: 'Conversations' }] : []),
    ...(shared ? [{ href: '/rooms', label: 'Shared rooms' }] : []),
    ...(!remote ? [{ href: '/research', label: 'Research' }, { href: '/documents', label: 'Documents' }, { href: '/artifacts', label: 'Prototypes & apps' }] : []),
    { href: '/tasks', label: 'Next steps' },
  ];
  if (!['/chat', '/rooms', '/research', '/documents', '/artifacts', '/tasks', '/my-work'].some(path => pathname === path || pathname.startsWith(`${path}/`))) return null;
  return (
    <nav aria-label="Work navigation" className="shrink-0 border-b border-outline-variant/40 bg-surface-container-lowest px-3 py-2 font-sans">
      <div className="flex items-center gap-2 overflow-x-auto text-xs">
        {items.map(item => <Link key={item.href} href={item.href === '/research' && research.owner === user?.id && research.job ? `/research?job=${encodeURIComponent(research.job)}` : item.href}
          aria-current={pathname === item.href || pathname.startsWith(`${item.href}/`) ? 'page' : undefined}
          className={cn('shrink-0 rounded-full px-3 py-1.5 transition-colors', pathname === item.href || pathname.startsWith(`${item.href}/`) ? 'bg-primary-container/40 text-primary' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface')}>
          {item.label}
        </Link>)}
      </div>
      {pathname === '/research' && shared && <p className="px-3 mt-1 text-[11px] text-on-surface-variant">Research here is personal. For work visible to the team, ask your companion in a shared room.</p>}
    </nav>
  );
}

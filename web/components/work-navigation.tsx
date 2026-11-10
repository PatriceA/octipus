'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePageOn } from '@/lib/modules';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';

/** Navigation only: changing views never publishes or copies a conversation. */
export function WorkNavigation() {
  const pathname = usePathname();
  const { activeWorkspace } = useWorkspace();
  const pageOn = usePageOn();
  const remote = activeWorkspace?.kind === 'remote';
  const shared = activeWorkspace?.kind === 'shared' || remote;
  const items = [
    ...(!remote ? [{ href: '/chat', label: 'Conversations' }] : []),
    ...(shared ? [{ href: '/rooms', label: 'Shared rooms' }] : []),
    ...(!remote ? [{ href: '/documents', label: 'Documents' }, { href: '/artifacts', label: 'Prototypes & apps' }] : []),
    { href: '/tasks', label: 'Next steps' },
  ].filter((item) => pageOn(item.href));
  if (!['/chat', '/rooms', '/documents', '/artifacts', '/tasks', '/my-work'].some(path => pathname === path || pathname.startsWith(`${path}/`))) return null;
  return (
    <nav aria-label="Work navigation" className="shrink-0 border-b border-outline-variant/40 bg-surface-container-lowest px-3 py-2 font-sans">
      <div className="flex items-center gap-2 overflow-x-auto text-xs">
        {items.map(item => <Link key={item.href} href={item.href}
          aria-current={pathname === item.href || pathname.startsWith(`${item.href}/`) ? 'page' : undefined}
          className={cn('shrink-0 rounded-full px-3 py-1.5 transition-colors', pathname === item.href || pathname.startsWith(`${item.href}/`) ? 'bg-primary-container/40 text-primary' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface')}>
          {item.label}
        </Link>)}
      </div>
    </nav>
  );
}

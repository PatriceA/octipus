'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/admin/plugins', title: 'Installed' },
  { href: '/admin/plugins/marketplace', title: 'Marketplace' },
  { href: '/admin/plugins/updates', title: 'Updates' },
];

/** Admin → Plugins: Installed, Marketplace and Updates (docs/PLUGIN-PACKAGES.md#marketplace). */
export default function AdminPluginsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="space-y-4">
      <nav aria-label="Plugins" className="flex gap-1 border-b border-outline-variant/50" data-testid="plugin-tabs">
        {TABS.map((tab) => {
          const current = tab.href === '/admin/plugins' ? pathname === tab.href : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={current ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary',
                current ? 'border-primary font-medium text-on-surface' : 'border-transparent text-on-surface-variant hover:text-on-surface',
              )}
            >
              {tab.title}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}

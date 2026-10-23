'use client';

import { Boxes } from 'lucide-react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { type ModuleView, useModules } from '@/lib/modules';

/** The module whose page `pathname` is, when that module is off. */
export function offModuleFor(pathname: string, modules: readonly ModuleView[] | undefined): ModuleView | undefined {
  return modules?.find((m) => !m.on && m.pages.some((page) => pathname === page || pathname.startsWith(`${page}/`)));
}

/**
 * A page of a module that is off (docs/MODULES.md), reached by a bookmark or
 * a link: says so instead of a page whose API answers 404. Admins get the
 * way to turn it on.
 */
export function ModuleGate({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const { user } = useAuth();
  const modules = useModules();
  const off = offModuleFor(pathname, modules.data?.modules);
  if (!off) return <>{children}</>;
  return (
    <div className="max-w-xl space-y-2 font-mono text-[13px]" data-testid="module-off">
      <h1 className="flex items-center gap-2 text-on-surface"><Boxes className="w-4 h-4 text-on-surface-variant" />This module is off</h1>
      <p className="text-on-surface-variant">{off.title} is switched off on this install. Its data is kept and comes back when it is turned on again.</p>
      {user?.isAdmin
        ? <Link href="/settings?tab=modules" className="text-primary hover:underline">Settings → Modules</Link>
        : <p className="text-on-surface-variant">An admin can turn it on in Settings → Modules.</p>}
    </div>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { useAuth } from '@/lib/auth-context';
import { usePageOn } from '@/lib/modules';
import { ADMIN_SECTIONS } from '@/lib/admin-navigation';
import './admin-workspace.css';

/**
 * Admin layout — Phase 2c.
 *
 * Gates the entire `/admin/*` tree behind `principal.isAdmin === true`.
 * Non-admin users are redirected to `/`. The check runs on every
 * navigation (the auth context might tell us "loading" first, then
 * "not admin" — we wait for `isLoading` to settle before redirecting).
 *
 * The server-side admin routes already enforce the check (see
 * `src/api/routes/admin.ts`); this redirect is purely UX so a
 * non-admin doesn't land on a page where every API call returns 403.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // Tabs of a module that is off are left out (docs/MODULES.md).
  const pageOn = usePageOn();

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) { router.replace('/login'); return; }
    if (!user?.isAdmin) router.replace('/');
  }, [isLoading, isAuthenticated, user, router]);

  if (isLoading || !user?.isAdmin) {
    return <div className="p-8 text-on-surface-variant font-sans">checking permissions…</div>;
  }

  const tabs = [{ href: '/admin', title: 'Overview' }, ...ADMIN_SECTIONS.filter(section => pageOn(section.href))];

  return (
    <div className="admin-workspace">
      <PageHeader
        title="Administration"
        description="Manage people, connections and controls for this installation."
      />

      <nav className="admin-navigation" aria-label="Administration sections">
        {tabs.map((t) => {
          const active = pathname === t.href || (t.href !== '/admin' && pathname.startsWith(t.href + '/'));
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? 'page' : undefined}
              className={active ? 'admin-section-link is-current' : 'admin-section-link'}
            >
              {t.title}
            </Link>
          );
        })}
      </nav>

      <div className="admin-content">{children}</div>
    </div>
  );
}

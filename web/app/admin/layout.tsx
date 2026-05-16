'use client';

import { Shield } from 'lucide-react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useAuth } from '@/lib/auth-context';

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

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) { router.replace('/login'); return; }
    if (!user?.isAdmin) router.replace('/');
  }, [isLoading, isAuthenticated, user, router]);

  if (isLoading || !user?.isAdmin) {
    return <div className="p-8 text-on-surface-variant">Checking permissions…</div>;
  }

  const tabs = [
    { href: '/admin/users', label: 'Users' },
    { href: '/admin/orgs', label: 'Orgs' },
    { href: '/admin/quotas', label: 'Quotas' },
    { href: '/admin/audit', label: 'Audit log' },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Shield className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl text-on-surface">Admin console</h1>
          <p className="text-on-surface-variant">Manage users and inspect the audit log.</p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-outline-variant/10">
        {tabs.map((t) => {
          const active = pathname === t.href || pathname.startsWith(t.href + '/');
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                active
                  ? 'border-primary text-white'
                  : 'border-transparent text-on-surface-variant hover:text-white'
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      <div>{children}</div>
    </div>
  );
}

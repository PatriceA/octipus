'use client';

import { Loader2 } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { GlobalPermissionBanner } from './global-permission-banner';
import { Header } from './header';
import { ImpersonationBanner } from './impersonation-banner';
import { Sidebar } from './sidebar';

const PUBLIC_ROUTES = ['/login', '/register', '/forgot-password', '/setup'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const isPublicRoute = PUBLIC_ROUTES.some(route => pathname.startsWith(route));

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPublicRoute) {
      router.replace('/login');
    }
  }, [isLoading, isAuthenticated, isPublicRoute, router]);

  if (isPublicRoute) {
    return <>{children}</>;
  }

  if (isLoading || !isAuthenticated) {
    // TUI-style boot splash: prompt + spinner.
    return (
      <div className="flex h-screen items-center justify-center bg-background font-mono">
        <div className="flex items-center gap-3 text-on-surface-variant text-[13px]">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-primary">❯</span>
          <span>booting octipus<span className="term-caret" /></span>
        </div>
      </div>
    );
  }

  // Full-bleed pages manage their own layout/scroll edge-to-edge (no page
  // padding, no entrance wrapper) — chat and the notes workspace.
  const fullBleed = pathname === '/chat' || pathname.startsWith('/notes');

  return (
    <div className="flex flex-col h-screen bg-background text-on-surface overflow-hidden font-mono">
      <ImpersonationBanner />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <div className="flex flex-col flex-1 min-w-0 bg-background">
          <Header />
          <main
            tabIndex={pathname === '/chat' ? undefined : 0}
            aria-label="Page content"
            className={cn(
              'flex-1 overflow-hidden bg-background',
              fullBleed ? 'p-0' : 'overflow-y-auto p-6'
            )}
          >
            {fullBleed ? (
              children
            ) : (
              // Re-keying on navigation gives every page the same quick
              // fade/slide entrance the mobile app uses.
              <div key={pathname} className="animate-enter">
                {children}
              </div>
            )}
          </main>
        </div>
        {/* Full-bleed pages (chat, notes) render their own UI edge-to-edge;
            the floating permission banner would leave a gap, so skip it. */}
        {!fullBleed && <GlobalPermissionBanner />}
      </div>
    </div>
  );
}

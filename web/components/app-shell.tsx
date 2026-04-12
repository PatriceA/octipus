'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Sidebar } from './sidebar';
import { Header } from './header';
import { GlobalPermissionBanner } from './global-permission-banner';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

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
    return (
      <div className="flex h-screen items-center justify-center bg-[#0e0e0e]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <span className="text-sm text-on-surface-variant">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-[#0e0e0e] text-white overflow-hidden">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0">
        <Header />
        <main className={cn(
          'flex-1 overflow-hidden neural-grid',
          pathname === '/chat' ? 'p-0' : 'overflow-y-auto p-8'
        )}>{children}</main>
      </div>
      <GlobalPermissionBanner />
    </div>
  );
}

'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { DesktopConnectionGate } from '@/components/desktop-connection-gate';
import { AuthProvider } from '@/lib/auth-context';
import { PermissionProvider } from '@/lib/permission-context';
import { isDesktop } from '@/lib/tauri-backend';
import { WorkspaceProvider } from '@/lib/workspace-context';

export function Providers({ children }: { children: ReactNode }) {
  // On desktop (Tauri) the API base is a user-chosen backend URL. Gate the
  // whole provider tree behind DesktopConnectionGate so no request fires until
  // a reachable backend is resolved. In the web build `isDesktop()` is false →
  // the gate is skipped entirely.
  const [desktop] = useState(() => isDesktop());

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  const tree = (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WorkspaceProvider>
          <PermissionProvider>{children}</PermissionProvider>
        </WorkspaceProvider>
      </AuthProvider>
    </QueryClientProvider>
  );

  return desktop ? <DesktopConnectionGate>{tree}</DesktopConnectionGate> : tree;
}

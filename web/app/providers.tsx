'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { AuthProvider } from '@/lib/auth-context';
import { PermissionProvider } from '@/lib/permission-context';
import { isDesktop, resolveBackendPort } from '@/lib/tauri-backend';
import { WorkspaceProvider } from '@/lib/workspace-context';

export function Providers({ children }: { children: ReactNode }) {
  // On desktop (Tauri) the API base depends on the sidecar's runtime port.
  // Block render until it's resolved so no request fires against the wrong
  // origin. In the web build `isDesktop()` is false → ready immediately.
  const [backendReady, setBackendReady] = useState(() => !isDesktop());
  useEffect(() => {
    if (!isDesktop()) return;
    resolveBackendPort()
      .then(() => setBackendReady(true))
      .catch((err) => {
        console.error('Failed to resolve backend sidecar port', err);
      });
  }, []);

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

  if (!backendReady) {
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WorkspaceProvider>
          <PermissionProvider>
            {children}
          </PermissionProvider>
        </WorkspaceProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

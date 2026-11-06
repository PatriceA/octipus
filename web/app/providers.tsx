'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { DesktopConnectionGate } from '@/components/desktop-connection-gate';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth-context';
import { CompanionPresenceProvider } from '@/lib/companion-presence';
import { GatewayProvider } from '@/lib/gateway-context';
import { PermissionProvider } from '@/lib/permission-context';
import { WorkspaceProvider } from '@/lib/workspace-context';

// Baked at build time (see next.config.mjs). The desktop static export sets it;
// the web build leaves it empty. Branching on this constant — rather than a
// runtime `isDesktop()` window check — keeps the prerender and the client
// render identical, avoiding a hydration mismatch.
const IS_DESKTOP_BUILD = process.env.NEXT_PUBLIC_DESKTOP_BUILD === '1';

export function Providers({ children }: { children: ReactNode }) {
  // On desktop the API base is a user-chosen backend URL. Gate the whole
  // provider tree behind DesktopConnectionGate so no request fires until a
  // reachable backend is resolved. The web build skips the gate entirely.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
            // Respect the server's cooldown after restart bursts rather than
            // exhausting query retries while the API client is still paused.
            retryDelay: (attempt, error) => error instanceof ApiError && error.status === 429
              ? Math.max(1000, error.retryAfterMs) + Math.random() * 1000
              : Math.min(1000 * 2 ** attempt, 30_000),
          },
        },
      })
  );

  const tree = (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <GatewayProvider>
          <WorkspaceProvider>
            <PermissionProvider>
              <CompanionPresenceProvider>{children}</CompanionPresenceProvider>
            </PermissionProvider>
          </WorkspaceProvider>
        </GatewayProvider>
      </AuthProvider>
    </QueryClientProvider>
  );

  return IS_DESKTOP_BUILD ? <DesktopConnectionGate>{tree}</DesktopConnectionGate> : tree;
}

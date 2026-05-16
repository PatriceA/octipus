'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/**
 * Phase 3d — global banner that appears whenever the current
 * principal is being impersonated by an admin.
 *
 * The auth-derive middleware swaps the principal to the target user
 * during impersonation, so `/auth/me` returns the target's identity;
 * the impersonating admin's id is exposed via the `actorUserId` /
 * `actorUsername` fields the principal carries.
 *
 * The banner sits at the top of every page (mounted in the root
 * layout) and offers a single "Stop" button that posts to
 * /api/admin/impersonate/stop. After stopping, the page reloads so
 * every cached query re-runs with the admin's own identity.
 */
interface MeResponse {
  id: string;
  username: string;
  isAdmin: boolean;
  actorUserId?: string | null;
  actorUsername?: string | null;
}

export function ImpersonationBanner() {
  const queryClient = useQueryClient();
  const { isAuthenticated } = useAuth();

  const { data } = useQuery({
    queryKey: ['impersonation-banner', 'me'],
    queryFn: () => api.get<MeResponse>('/auth/me'),
    enabled: isAuthenticated,
    refetchInterval: 30_000,
  });

  const stopMutation = useMutation({
    mutationFn: () => api.post('/admin/impersonate/stop'),
    onSuccess: () => {
      queryClient.invalidateQueries();
      // Reload so every cached query re-runs with the actor's identity.
      if (typeof window !== 'undefined') window.location.reload();
    },
  });

  if (!data?.actorUserId) return null;

  return (
    // Renders inline at the top of AppShell as a full-width bar so it pushes
    // sidebar + header + content down rather than overlapping them. Solid
    // background (no glass / blur) — the bar is a stop-the-world warning,
    // not decoration. z-50 keeps it above any sticky pickers / overlays in
    // the page body if a route ever escapes the AppShell flow.
    <div className="relative z-50 w-full bg-warning text-[#0e0e0e] px-4 py-2 text-sm font-medium shadow-md border-b border-yellow-700">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <Eye className="w-4 h-4 shrink-0" />
          <span className="truncate">
            <strong>{data.actorUsername ?? data.actorUserId}</strong> is acting as{' '}
            <strong>{data.username}</strong>. Every action is audited.
          </span>
        </div>
        <button
          type="button"
          onClick={() => stopMutation.mutate()}
          disabled={stopMutation.isPending}
          className="px-3 py-1 bg-background text-yellow-200 rounded text-xs font-bold uppercase tracking-wide hover:bg-black disabled:opacity-50 cursor-pointer shrink-0"
        >
          {stopMutation.isPending ? 'Stopping…' : 'Stop'}
        </button>
      </div>
    </div>
  );
}

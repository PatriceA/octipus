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
    <div className="fixed top-0 left-0 right-0 z-40 bg-yellow-600 text-[#0e0e0e] px-4 py-2 text-sm font-medium shadow-md">
      <div className="flex items-center justify-between max-w-6xl mx-auto">
        <div className="flex items-center gap-2">
          <Eye className="w-4 h-4" />
          <span>
            <strong>{data.actorUsername ?? data.actorUserId}</strong> is acting as{' '}
            <strong>{data.username}</strong>. Every action is audited.
          </span>
        </div>
        <button
          type="button"
          onClick={() => stopMutation.mutate()}
          disabled={stopMutation.isPending}
          className="px-3 py-1 bg-[#0e0e0e] text-yellow-200 rounded text-xs font-bold uppercase tracking-wide hover:bg-black disabled:opacity-50 cursor-pointer"
        >
          {stopMutation.isPending ? 'Stopping…' : 'Stop'}
        </button>
      </div>
    </div>
  );
}

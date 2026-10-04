'use client';

import { useQuery } from '@tanstack/react-query';
import { Loader2, UsersRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { loginPathReturningTo } from '../../../src/shared/return-to';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { type SpaceRole, useWorkspace } from '@/lib/workspace-context';

/** `GET /api/invites/:token` — what the link invites to; no members, no content. */
interface InvitePreview {
  spaceName: string;
  inviterName: string | null;
  role: Exclude<SpaceRole, 'owner'>;
  expiresAt: string;
}

const ROLE_MEANING: Record<InvitePreview['role'], string> = {
  editor: 'read and edit everything in the space',
  commenter: 'read everything and comment on tasks',
  viewer: 'read everything in the space',
  guest: 'see only what you are given',
};

/**
 * `/join/:token`: an invite link. Anyone with the link sees what it invites
 * to; a signed-in user joins with one click, anyone else signs in or
 * registers and comes back here (`returnTo`).
 */
export default function JoinPage() {
  const { token = '' } = useParams<{ token: string }>();
  const router = useRouter();
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const { refresh, switchWorkspace } = useWorkspace();
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InvitePreview>(`/invites/${encodeURIComponent(token)}`),
    retry: false,
  });

  const here = `/join/${token}`;
  const signInHref = loginPathReturningTo(here);
  const registerHref = `/login?mode=register&returnTo=${encodeURIComponent(here)}`;

  const join = async () => {
    setJoining(true);
    setJoinError(null);
    try {
      const res = await api.post<{ workspaceId: string; role: SpaceRole; alreadyMember: boolean }>(
        `/invites/${encodeURIComponent(token)}/accept`,
      );
      // The new space is in the list once re-read; then it is selected.
      await refresh();
      switchWorkspace(res.workspaceId);
      router.push('/');
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Could not join');
      setJoining(false);
    }
  };

  const notFound = preview.error instanceof ApiError && preview.error.status === 404;

  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center p-4 font-mono overflow-hidden">
      <div aria-hidden className="absolute inset-0 neural-grid" />
      <div aria-hidden className="absolute inset-0 crt-scanlines" />
      <div className="relative w-full max-w-md animate-enter">
        <div className="mb-6 text-[13px]">
          <span className="text-outline font-semibold">octi:</span>
          <span className="text-on-surface">~/join</span>
          <span className="text-primary font-bold"> $</span>
          <span className="ml-2 text-on-surface-variant">shared space invite</span>
          <span aria-hidden className="term-caret" />
        </div>

        <div className="term-frame glow-accent p-4 space-y-4">
          {preview.isLoading ? (
            <p className="text-[12px] text-on-surface-variant flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> reading the invite…
            </p>
          ) : notFound ? (
            <div className="space-y-2" data-testid="invite-invalid">
              <p className="text-[13px] text-on-surface">This invite link is not valid any more.</p>
              <p className="text-[12px] text-on-surface-variant">
                It may have expired, been used up or revoked, or its space was archived. Ask whoever sent it for a new link.
              </p>
            </div>
          ) : preview.error ? (
            <p className="text-[12px] text-error">! {(preview.error as Error).message}</p>
          ) : preview.data ? (
            <>
              <div className="space-y-1.5" data-testid="invite-preview">
                <p className="text-[12px] text-on-surface-variant">
                  {preview.data.inviterName ? <><span className="text-on-surface">{preview.data.inviterName}</span> invites you to</> : 'You are invited to'}
                </p>
                <p className="text-lg text-on-surface flex items-center gap-2">
                  <UsersRound className="w-5 h-5 text-primary" /> {preview.data.spaceName}
                </p>
                <p className="text-[12px] text-on-surface-variant">
                  as <span className="text-primary">{preview.data.role}</span> — {ROLE_MEANING[preview.data.role]}.
                </p>
                <p className="text-[11px] text-outline-variant">
                  link expires {new Date(preview.data.expiresAt).toLocaleString()}
                </p>
              </div>

              {joinError && (
                <div className="px-2 py-1.5 border border-error/60 bg-error-container/40 rounded-xs text-[12px] text-error">
                  ! {joinError}
                </div>
              )}

              {authLoading ? (
                <Loader2 className="w-4 h-4 animate-spin text-on-surface-variant" />
              ) : isAuthenticated ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    onClick={join}
                    disabled={joining}
                    className="w-full py-2 bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 flex items-center justify-center gap-2 text-[13px] cursor-pointer"
                  >
                    {joining ? <Loader2 className="w-4 h-4 animate-spin" /> : `❯ join ${preview.data.spaceName}`}
                  </button>
                  <p className="text-[11px] text-on-surface-variant text-center">signed in as {user?.username}</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <Link
                    href={signInHref}
                    className="py-2 text-center bg-primary text-on-primary rounded-xs hover:bg-primary-dim text-[13px]"
                  >
                    sign in to join
                  </Link>
                  <Link
                    href={registerHref}
                    className="py-2 text-center border border-outline-variant/60 text-on-surface rounded-xs hover:bg-surface-container-high text-[13px]"
                  >
                    register
                  </Link>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

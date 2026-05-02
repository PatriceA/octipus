'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Link2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

/**
 * Link account — Phase 2d.
 *
 * Lands here from a Telegram / Slack / WhatsApp / Teams deep-link
 * that the channel adapter sends when it receives a message from an
 * unbound external_id. The adapter mints a 6-character one-time code
 * via `createPendingLink()` server-side and ships the code in the
 * deep-link's query string (or in the channel reply text if the
 * deep-link is unavailable).
 *
 * The user lands here, signs in if necessary, enters or confirms the
 * code, and the server creates a `channel_identities` row keyed to
 * their authenticated user. From that point on, channel adapters can
 * resolve the external_id back to this user without any further
 * action.
 *
 * The page also lists existing bindings with an unbind button so a
 * user can revoke a channel mapping if they switch accounts (e.g.
 * new Slack workspace).
 */

interface ChannelBinding {
  id: string;
  channelType: string;
  externalId: string;
  externalHandle: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export default function LinkAccountPage() {
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading } = useAuth();
  const searchParams = useSearchParams();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ChannelBinding | null>(null);

  // If the deep-link carried `?code=ABCDEF`, pre-fill it.
  useEffect(() => {
    const fromUrl = searchParams.get('code');
    if (fromUrl) setCode(fromUrl.toUpperCase().slice(0, 12));
  }, [searchParams]);

  const { data, refetch } = useQuery({
    queryKey: ['channel-bindings'],
    queryFn: () => api.get<{ bindings: ChannelBinding[] }>('/auth/channel-bindings'),
    enabled: isAuthenticated,
  });

  const redeemMutation = useMutation({
    mutationFn: (c: string) => api.post<ChannelBinding>('/auth/channel-bindings/redeem', { code: c }),
    onSuccess: (binding) => {
      setSuccess(binding);
      setCode('');
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['channel-bindings'] });
    },
    onError: (err: Error) => {
      setError(humanizeRedeemError(err.message));
      setSuccess(null);
    },
  });

  const unbindMutation = useMutation({
    mutationFn: ({ channelType, externalId }: { channelType: string; externalId: string }) =>
      api.delete(`/auth/channel-bindings/${channelType}/${encodeURIComponent(externalId)}`),
    onSuccess: () => refetch(),
  });

  if (isLoading) return <div className="p-8 text-on-surface-variant">Loading…</div>;
  if (!isAuthenticated) {
    return (
      <div className="max-w-xl mx-auto p-8 space-y-3">
        <h1 className="text-2xl font-extrabold tracking-tighter text-white">Link account</h1>
        <p className="text-on-surface-variant">
          Sign in first, then return to this page to enter the code from your channel.
        </p>
        <a href="/login" className="inline-block px-4 py-2 bg-primary text-[#0e0e0e] rounded-lg font-medium">
          Go to sign in
        </a>
      </div>
    );
  }

  const handleSubmit = () => {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length < 6) return;
    redeemMutation.mutate(trimmed);
  };

  return (
    <div className="max-w-xl mx-auto p-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Link2 className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tighter text-white">Link a channel</h1>
          <p className="text-on-surface-variant text-sm">
            Connect a Telegram chat, Slack DM, WhatsApp number, or Teams account to this user.
          </p>
        </div>
      </div>

      <div className="bg-[#1a1a1a] rounded-2xl p-5 space-y-4">
        <h2 className="font-medium text-white">Enter the code from your channel</h2>
        <p className="text-xs text-on-surface-variant">
          The channel sent you a 6-character code along with this page. Codes expire after 15 minutes.
        </p>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12))}
          placeholder="ABCDEF"
          className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-center font-mono text-2xl tracking-widest focus:ring-1 focus:ring-primary"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={code.length < 6 || redeemMutation.isPending}
          className="w-full py-3 bg-primary text-[#0e0e0e] rounded-lg font-medium hover:bg-primary-container disabled:opacity-50 cursor-pointer"
        >
          {redeemMutation.isPending ? 'Linking…' : 'Link this channel'}
        </button>
        {error && (
          <div className="p-2 bg-error-dim/10 border border-error-dim/20 rounded text-sm text-error">{error}</div>
        )}
        {success && (
          <div className="p-3 bg-green-900/20 border border-green-700/30 rounded-lg text-sm text-green-200 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            <span>
              Linked <code className="font-mono">{success.channelType}</code>:
              <span className="font-mono ml-1">{success.externalId}</span>
            </span>
          </div>
        )}
      </div>

      {data && data.bindings.length > 0 && (
        <div className="bg-[#1a1a1a] rounded-2xl p-5 space-y-3">
          <h2 className="font-medium text-white text-sm">Linked channels</h2>
          <div className="space-y-2">
            {data.bindings.map((b) => (
              <div key={b.id} className="flex items-center justify-between p-3 bg-[#131313] rounded-lg">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white capitalize">{b.channelType}</span>
                    <code className="text-xs text-on-surface-variant font-mono truncate">{b.externalId}</code>
                  </div>
                  {b.externalHandle && (
                    <p className="text-xs text-on-surface-variant">{b.externalHandle}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => unbindMutation.mutate({ channelType: b.channelType, externalId: b.externalId })}
                  className="ml-3 p-2 rounded-lg text-on-surface-variant hover:bg-[#262626] hover:text-red-400 cursor-pointer"
                  aria-label={`Unbind ${b.channelType}`}
                  title="Unbind"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function humanizeRedeemError(raw: string): string {
  if (raw.includes('unknown_code')) return 'That code doesn’t match anything. Double-check the message from your channel.';
  if (raw.includes('expired')) return 'That code has expired. Send a fresh message in your channel to get a new one.';
  if (raw.includes('already_redeemed')) return 'That code was already used. Send a fresh message in your channel to get a new one.';
  if (raw.includes('already_bound_to_another_user')) return 'This channel account is already linked to a different Octipus user.';
  return raw || 'Could not link the channel.';
}

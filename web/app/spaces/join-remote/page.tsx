'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Link2, ShieldCheck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { type JoinPreview, type RemoteSpace, remoteSpacesKey } from '@/lib/remote-spaces';
import { useWorkspace } from '@/lib/workspace-context';

/** A link handed over in the fragment (`#link=…`, from another install's /join page): never sent to a server. */
function linkFromFragment(): string {
  if (typeof window === 'undefined') return '';
  const match = /(?:^#|&)link=([^&]+)/.exec(window.location.hash);
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

/**
 * "Join a space on another install" (docs/plans/federation-spec.md §6.2,
 * §8.3): paste the invite link the space's owner sent, compare the host
 * fingerprint this install shows with the one the host shows, confirm.
 * Nothing is dialled before the confirmation; the link is then pinned to
 * that fingerprint. The space joins the picker under "on other installs".
 */
export default function JoinRemoteSpacePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { refresh, switchWorkspace } = useWorkspace();
  const [link, setLink] = useState(linkFromFragment);
  const [preview, setPreview] = useState<(JoinPreview & { visiting: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const res = await api.post<{ preview: JoinPreview; visiting: boolean }>('/remote-spaces/join', { link: link.trim() });
      setPreview({ ...res.preview, visiting: res.visiting });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const { remoteSpace } = await api.post<{ remoteSpace: RemoteSpace }>('/remote-spaces/join', { link: link.trim(), confirm: true });
      await qc.invalidateQueries({ queryKey: remoteSpacesKey });
      await refresh();
      switchWorkspace(remoteSpace.id);
      router.push('/rooms');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5 font-mono" data-testid="join-remote">
      <div>
        <h1 className="text-[15px] text-on-surface flex items-center gap-2"><Link2 className="w-4 h-4" /> join a space on another install</h1>
        <p className="mt-1 text-[12px] text-on-surface-variant leading-relaxed">
          Paste the invite link the space&apos;s owner sent you — the whole link, with the part after <code>#octipus=</code>.
          The space stays on its host: you read and post there through this install, and your own agent works in it
          on your models here. Nothing of it is kept here but its name and your role.
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="remote-link" className="text-[10px] uppercase tracking-wider text-outline-variant">invite link</label>
        <textarea
          id="remote-link"
          value={link}
          onChange={(e) => { setLink(e.target.value); setPreview(null); }}
          rows={3}
          placeholder="https://octipus.example.org/join/…#octipus=…"
          className="w-full px-2 py-1.5 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[12px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary break-all"
        />
        <button
          type="button"
          onClick={() => void check()}
          disabled={busy || !link.trim()}
          className="px-2.5 py-1 text-[12px] border border-outline-variant/60 rounded-xs text-on-surface hover:bg-surface-container-high disabled:opacity-50 cursor-pointer"
        >
          check the link
        </button>
      </div>

      {error && <p role="alert" className="text-[12px] text-error">! {error}</p>}

      {preview && (
        <div className="term-frame rounded-xs p-3 space-y-2" data-testid="join-remote-preview">
          <p className="text-[12px] text-on-surface flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-primary" /> the host</p>
          <dl className="text-[12px] grid grid-cols-[8rem_1fr] gap-y-1">
            <dt className="text-on-surface-variant">address</dt><dd className="break-all">{preview.origin}</dd>
            <dt className="text-on-surface-variant">fingerprint</dt><dd className="break-all text-primary" data-testid="host-fingerprint">{preview.fingerprint}</dd>
            <dt className="text-on-surface-variant">badge</dt><dd>{preview.badge}</dd>
          </dl>
          <p className="text-[11px] text-on-surface-variant leading-relaxed">
            Compare the fingerprint with the one the space&apos;s owner sees (or the one on the host&apos;s /join page). This
            install connects only to the install that proves it holds this fingerprint.
          </p>
          {!preview.visiting ? (
            <p role="alert" className="text-[12px] text-warning">
              This install does not join spaces on other installs: an admin sets <code>federation.mode</code> to <code>visit</code> or <code>both</code>.
            </p>
          ) : (
            <button
              type="button"
              onClick={() => void join()}
              disabled={busy}
              className="px-2.5 py-1 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer"
            >
              {busy ? 'joining…' : '❯ the fingerprint matches — join'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

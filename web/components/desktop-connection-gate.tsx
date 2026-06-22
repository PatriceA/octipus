'use client';

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { pingBackend, resolveBackendUrl, setBackendUrl } from '@/lib/tauri-backend';

type Phase = 'checking' | 'connected' | 'prompt';

/**
 * Desktop-only startup gate. The Tauri client doesn't run a backend — it
 * connects to one. On launch we resolve the saved backend URL and health-check
 * it; if it's unreachable we show a form so the user can point the app at any
 * Octipus backend (local `octi start`, LAN host, or remote deployment).
 *
 * Renders `children` unchanged once a backend is reachable. The web build never
 * mounts this (Providers only uses it when `isDesktop()` is true).
 */
export function DesktopConnectionGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Initial resolve + health check of the saved backend URL.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await resolveBackendUrl();
      if (cancelled) return;
      setUrl(saved);
      if (await pingBackend(saved)) {
        if (!cancelled) setPhase('connected');
      } else if (!cancelled) {
        setPhase('prompt');
      }
    })().catch(() => {
      if (!cancelled) setPhase('prompt');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    const candidate = url.trim();
    if (!/^https?:\/\//.test(candidate)) {
      setError('Enter a full URL starting with http:// or https://');
      return;
    }
    setBusy(true);
    try {
      if (!(await pingBackend(candidate))) {
        setError(`No Octipus backend responded at ${candidate}. Is it running?`);
        return;
      }
      await setBackendUrl(candidate);
      setPhase('connected');
    } catch (err) {
      setError((err as Error).message ?? 'Failed to connect');
    } finally {
      setBusy(false);
    }
  }, [url]);

  if (phase === 'connected') return <>{children}</>;

  if (phase === 'checking') {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-neutral-400">
        Connecting to backend…
      </div>
    );
  }

  // phase === 'prompt'
  return (
    <div className="flex h-screen items-center justify-center bg-neutral-950 p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-neutral-100">Connect to Octipus</h1>
          <p className="text-sm text-neutral-400">
            The desktop app connects to an Octipus backend. Enter its address —
            a local server (<code className="text-neutral-300">octi start</code>), a host on
            your network, or a remote deployment.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
          className="space-y-3"
        >
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:3005"
            autoFocus
            spellCheck={false}
            className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-[#8CACFF]"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-[#8CACFF] px-3 py-2 text-sm font-medium text-neutral-950 transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}

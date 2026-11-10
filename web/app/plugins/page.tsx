'use client';

import { Loader2, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, getApiUrl } from '@/lib/api';
import { bridgeNonce, isBridgeReady, pageFrameSrc, parseBridgeCall, pluginPageHref, usePluginPages, type BridgeCall, type PluginPageLink } from '@/lib/plugin-pages';

/** Calls a page may have in flight at once; more are answered `busy`. */
const MAX_IN_FLIGHT = 4;
/** Calls a page may start per second; more are answered `rate_limited` (the server limits too). */
const MAX_PER_SECOND = 10;

/** How long the confirmation's Allow button stays disabled, so a click meant for the page cannot land on it. */
const ARM_DELAY_MS = 700;

interface Pending {
  /** Distinct per request, so each one's dialog arms afresh. */
  seq: number;
  call: BridgeCall;
  effect: string;
  resolve: (allowed: boolean) => void;
}

/**
 * `/plugins/:name/<path>`: a plugin package's page (docs/PLUGIN-PACKAGES.md#pages),
 * its static HTML in a sandboxed frame (`allow-scripts` only: an opaque
 * origin with no access to this app, its cookies or storage). The frame talks
 * to the host only through the postMessage bridge here, which calls the
 * package's own tools as the signed-in user. A call the user's rules would
 * ask about is shown here, outside the frame, for the user to allow once or
 * refuse.
 */
export default function PluginPage() {
  const params = useParams();
  const name = params.name ?? '';
  const path = params['*'] ?? '';
  const pages = usePluginPages();
  const page = (pages.data ?? []).find((p) => p.plugin === name && p.path === path) ?? null;

  if (pages.isLoading) {
    return <main className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-on-surface-variant" /></main>;
  }
  if (!page) {
    return (
      <main className="p-6" data-testid="plugin-page-missing">
        <h1 className="text-lg font-semibold text-on-surface">Page not available</h1>
        <p className="mt-2 text-sm text-on-surface-variant">This plugin page does not exist, or its plugin is not enabled.</p>
      </main>
    );
  }
  return <PluginFrame key={pluginPageHref(page)} page={page} />;
}

function PluginFrame({ page }: { page: PluginPageLink }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const inFlight = useRef(0);
  const recent = useRef<number[]>([]);
  /** Calls waiting for the user's decision, oldest first; the first is shown. */
  const queue = useRef<Pending[]>([]);
  const [current, setCurrent] = useState<Pending | null>(null);
  const seq = useRef(0);
  /**
   * The page navigated its frame (a link, `location =`, a meta refresh): what
   * is there now is not the package's page, so the bridge is detached for
   * good and the frame emptied. Counted by `load` events: the first is the page.
   */
  const loads = useRef(0);
  const detached = useRef(false);
  const [navigatedAway, setNavigatedAway] = useState(false);
  /**
   * The bridge (web/lib/plugin-pages.ts): the nonce in the frame's URL
   * fragment, and the one port the page handed over with it. Nothing is ever
   * posted to the frame's window; everything goes over this port, which dies
   * with the page's document.
   */
  const [nonce] = useState(bridgeNonce);
  const port = useRef<MessagePort | null>(null);
  const path = pageFrameSrc(page);
  const src = path === null ? null
    : `${getApiUrl().replace(/\/api\/?$/, '')}${path}#octipus=${nonce}&parent=${encodeURIComponent(window.location.origin)}`;

  const reply = useCallback((message: Record<string, unknown>) => {
    if (detached.current) return;
    port.current?.postMessage({ octipus: 'result', ...message });
  }, []);

  const ask = useCallback((call: BridgeCall, effect: string) => new Promise<boolean>((resolve) => {
    if (detached.current) { resolve(false); return; }
    seq.current += 1;
    queue.current.push({ seq: seq.current, call, effect, resolve });
    setCurrent(queue.current[0]);
  }), []);

  const onLoad = () => {
    loads.current += 1;
    if (loads.current === 1 || detached.current) return;
    detached.current = true;
    port.current?.close();
    port.current = null;
    for (const p of queue.current.splice(0)) p.resolve(false);
    setCurrent(null);
    setNavigatedAway(true);
    if (frame.current) frame.current.src = 'about:blank';
  };

  const run = useCallback(async (call: BridgeCall) => {
    const url = `/plugins/${encodeURIComponent(page.plugin)}/call/${encodeURIComponent(call.tool)}`;
    try {
      let out: { result: unknown };
      try {
        out = await api.post<{ result: unknown }>(url, { args: call.args });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409 || err.body.code !== 'approval_required') throw err;
        const allowed = await ask(call, String(err.body.effect ?? 'write'));
        if (!allowed) {
          reply({ id: call.id, ok: false, error: 'You did not allow this call', code: 'denied_by_user' });
          return;
        }
        out = await api.post<{ result: unknown }>(url, { args: call.args, confirm: true });
      }
      reply({ id: call.id, ok: true, result: out.result });
    } catch (err) {
      const code = err instanceof ApiError ? String(err.body.code ?? err.status) : 'failed';
      reply({ id: call.id, ok: false, error: (err as Error).message, code });
    }
  }, [ask, page.plugin, reply]);

  // A call over the port: checked, limited, run.
  const onCall = useCallback((data: unknown) => {
    if (detached.current) return;
    const call = parseBridgeCall(data);
    if (!call) return;
    const now = Date.now();
    recent.current = recent.current.filter((t) => now - t < 1000);
    if (recent.current.length >= MAX_PER_SECOND) {
      reply({ id: call.id, ok: false, error: 'Too many calls; wait a moment', code: 'rate_limited' });
      return;
    }
    if (inFlight.current >= MAX_IN_FLIGHT) {
      reply({ id: call.id, ok: false, error: 'Too many calls at once', code: 'busy' });
      return;
    }
    recent.current.push(now);
    inFlight.current += 1;
    void run(call).finally(() => { inFlight.current -= 1; });
  }, [reply, run]);

  // The handshake: the first `ready` from this frame, with this nonce and one port. Later ones are ignored.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (port.current || detached.current || !frame.current || event.source !== frame.current.contentWindow || event.origin !== 'null') return;
      if (!isBridgeReady(event.data, nonce) || event.ports.length !== 1) return;
      const [p] = event.ports;
      port.current = p;
      p.onmessage = (e) => onCall(e.data);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [nonce, onCall]);

  // Leaving the page closes the port.
  useEffect(() => () => { port.current?.close(); port.current = null; }, []);

  // Leaving the page refuses whatever it still waits for.
  useEffect(() => {
    const waiting = queue.current;
    return () => { for (const p of waiting.splice(0)) p.resolve(false); };
  }, []);

  const decide = (allowed: boolean) => {
    queue.current.shift()?.resolve(allowed);
    setCurrent(queue.current[0] ?? null);
  };

  return (
    <main className="flex h-full min-h-0 flex-col" data-testid="plugin-page">
      <header className="flex items-center gap-2 border-b border-outline-variant/40 px-4 py-2">
        <h1 className="text-sm font-semibold text-on-surface">{page.title}</h1>
        <span className="text-xs text-on-surface-variant">{page.pluginTitle}</span>
      </header>
      {navigatedAway && (
        <p role="alert" data-testid="plugin-navigated" className="border-b border-outline-variant/40 px-4 py-2 text-xs text-error">
          This page navigated away from {page.plugin}&apos;s own page; it was closed and can no longer call the plugin. Reload to open it again.
        </p>
      )}
      <iframe
        ref={frame}
        title={`${page.pluginTitle}: ${page.title}`}
        src={navigatedAway || src === null ? 'about:blank' : src}
        onLoad={onLoad}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0 bg-surface"
        data-testid="plugin-frame"
      />
      {current && <ConfirmCall key={current.seq} page={page} pending={current} decide={decide} />}
    </main>
  );
}

/**
 * The app's own confirmation of a page's call, outside the page's frame: the
 * package (by name and title), the tool, its effect and the arguments. Allow
 * stays disabled for a moment, so a click aimed at the page underneath cannot
 * land on it.
 */
function ConfirmCall({ page, pending, decide }: { page: PluginPageLink; pending: Pending; decide: (allowed: boolean) => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="plugin-confirm-title" data-testid="plugin-confirm"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg border border-outline-variant bg-surface-container p-4 shadow-lg">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-accent" aria-hidden />
          <h2 id="plugin-confirm-title" className="text-sm font-semibold text-on-surface">
            The plugin <code className="font-mono">{page.plugin}</code> ({page.pluginTitle}) wants to run {pending.call.tool}
          </h2>
        </div>
        <p className="mt-2 text-xs text-on-surface-variant">
          {pending.effect === 'external'
            ? 'This tool acts outside the organisation (a payment, a message, a post).'
            : 'This tool changes data.'} It runs as you, with these arguments:
        </p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-surface-container-low p-2 text-xs text-on-surface">{JSON.stringify(pending.call.args, null, 2)}</pre>
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" onClick={() => decide(false)} className="rounded border border-outline-variant px-3 py-1.5 text-sm text-on-surface">Refuse</button>
          <button type="button" disabled={!armed} onClick={() => decide(true)} className="rounded bg-primary px-3 py-1.5 text-sm text-on-primary disabled:opacity-50">Allow once</button>
        </div>
      </div>
    </div>
  );
}

'use client';

/**
 * One interactive answer in a reply (docs/plans/inline-ui-spec.md §5.6).
 *
 * The page draws everything around the frame — header, notices, the link
 * chip, the suggestion strip, the footer — so the frame cannot fake any of
 * it (S12). Scripts wait for a click when the risk is higher (D10): a block
 * from history, a shared conversation, a session that read untrusted or
 * private data, an impersonating admin, a block that was open when the tab
 * froze, or an engine where navigation containment is not verified.
 */
import { Code2, ExternalLink, Loader2, Play, RotateCcw, Save, Send, Sparkles, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { clampInlineUiHeight, INLINE_UI_LIMITS } from '../../../../src/shared/inline-ui/limits';
import type { InlineUiErrorClass, InlineUiHostMessage, InlineUiOutcome } from '../../../../src/shared/inline-ui/bridge';
import { cn } from '@/lib/utils';
import { type InlineUiBlockData, type InlineUiHost, forgetInlineUiBlock, useInlineUiBlockFetch, useInlineUiHost } from './context';
import { InlineUiFrame } from './frame';
import { SaveAsArtifactDialog } from './save-dialog';

// ── Freeze guard (T6) ─────────────────────────────────────────────────────
// A block's marker is set while its frame is mounted and removed when it
// unmounts or the page hides. A hung renderer never runs `pagehide`, so a
// marker found when the page loads names a block that was open when the tab
// died: it waits for a click instead of freezing the conversation again.
const MARKER_PREFIX = 'octi-ui-mounted:';
const frozeAtLoad = new Set<string>();
const mountedMarkers = new Set<string>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch (err) {
    console.warn('[inline-ui] localStorage unavailable; the freeze guard is off', err);
    return null;
  }
}

if (typeof window !== 'undefined') {
  const s = storage();
  if (s) {
    try {
      for (let i = s.length - 1; i >= 0; i--) {
        const key = s.key(i);
        if (key?.startsWith(MARKER_PREFIX)) { frozeAtLoad.add(key.slice(MARKER_PREFIX.length)); s.removeItem(key); }
      }
    } catch (err) {
      console.warn('[inline-ui] could not read freeze markers', err);
    }
  }
  window.addEventListener('pagehide', () => {
    const st = storage();
    if (!st) return;
    try { for (const id of mountedMarkers) st.removeItem(MARKER_PREFIX + id); } catch (err) { console.warn('[inline-ui] could not clear freeze markers', err); }
  });
}

function setMarker(id: string, on: boolean): void {
  const s = storage();
  if (on) mountedMarkers.add(id); else mountedMarkers.delete(id);
  if (!s) return;
  try {
    if (on) s.setItem(MARKER_PREFIX + id, '1'); else s.removeItem(MARKER_PREFIX + id);
  } catch (err) {
    console.warn('[inline-ui] could not write a freeze marker', err);
  }
}

// ── Live frames cap (§5.6) ────────────────────────────────────────────────
// At most a few frames run at once; the least recently visible one is paused
// (unmounted to a placeholder) when another needs to start.
const live = new Map<string, { lastVisible: number; visible: boolean; pause: () => void }>();

function enforceCap(except: string): void {
  const cap = typeof window !== 'undefined' && window.innerWidth < 640 ? INLINE_UI_LIMITS.mountedFramesNarrow : INLINE_UI_LIMITS.mountedFrames;
  while (live.size > cap) {
    const victim = [...live.entries()].filter(([k, v]) => k !== except && !v.visible).sort((a, b) => a[1].lastVisible - b[1].lastVisible)[0];
    if (!victim) return;
    live.delete(victim[0]);
    victim[1].pause();
  }
}

/** Navigation containment (D9) is verified on Chromium engines only. */
function containmentVerified(): boolean {
  const ua = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData;
  return !!ua?.brands?.some((b) => /Chromium/i.test(b.brand));
}

type RunState =
  | { kind: 'waiting'; reason: 'history' | 'tainted' | 'shared' | 'impersonating' | 'froze' | 'engine'; high: boolean }
  | { kind: 'running' }
  | { kind: 'paused' }
  | { kind: 'stopped'; why: string };

function initialRun(block: InlineUiBlockData, host: InlineUiHost): RunState {
  if (frozeAtLoad.has(block.id)) return { kind: 'waiting', reason: 'froze', high: block.risk === 'high' };
  if (!block.scripts) return { kind: 'running' };
  const high = block.risk === 'high';
  if (!host.isLive(block.id)) return { kind: 'waiting', reason: 'history', high };
  if (block.tainted || high) return { kind: 'waiting', reason: 'tainted', high };
  if (host.shared || block.shared) return { kind: 'waiting', reason: 'shared', high };
  if (host.impersonating) return { kind: 'waiting', reason: 'impersonating', high };
  if (!containmentVerified()) return { kind: 'waiting', reason: 'engine', high };
  return { kind: 'running' };
}

const WAIT_TEXT: Record<Extract<RunState, { kind: 'waiting' }>['reason'], string> = {
  history: 'Its script runs when you start it.',
  tainted: 'This conversation read content from outside your control; its script runs only if you start it.',
  shared: 'Someone else’s request may have shaped this answer; its script runs only if you start it.',
  impersonating: 'You are acting as another user; scripts run only if you start them.',
  froze: 'This answer was open when the page last stopped responding.',
  engine: 'Scripts start on request in this browser.',
};

const REMOVED_TEXT: Record<string, string> = {
  element: 'elements that are not allowed',
  cost: 'graphics beyond the size limits',
  'credential-input': 'a password or file field',
  'inline-handler': 'inline event attributes',
  attribute: 'attributes that are not allowed',
  'text-security': 'hidden-text styling',
  url: 'links that are not https',
  'remote-resource': 'remote images or media',
};

interface Suggestion { text: string; at: number }

export function InlineUiBlock({ id, title }: { id: string; title: string }) {
  const host = useInlineUiHost();
  const [attempt, setAttempt] = useState(0);
  const pending = useInlineUiBlockFetch(host, id, attempt);
  const [data, setData] = useState<{ block: InlineUiBlockData } | { error: 'not_found' | 'failed' } | null>(null);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    pending.then(
      (block) => { if (!cancelled) setData({ block }); },
      (err: unknown) => {
        if (cancelled) return;
        const status = (err as { status?: number })?.status;
        setData({ error: status === 404 ? 'not_found' : 'failed' });
      },
    );
    return () => { cancelled = true; };
  }, [pending]);

  if (!host) return <p className="text-sm text-on-surface-variant">▸ Interactive answer “{title}”</p>;

  return (
    <section
      aria-label={`Interactive answer: ${title}`}
      data-testid="inline-ui-block"
      data-block-id={id}
      className="my-2 rounded-lg border border-outline-variant/40 bg-surface-container-low/60 overflow-hidden min-w-0"
    >
      {data === null && (
        <div className="flex items-center gap-2 px-3 py-3 text-sm text-on-surface-variant"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading “{title}”…</div>
      )}
      {data && 'error' in data && (
        <div role="status" className="flex items-center gap-2 px-3 py-3 text-sm text-on-surface-variant">
          <TriangleAlert className="h-4 w-4 text-warning" aria-hidden />
          {data.error === 'not_found'
            ? <>Interactive answer “{title}” is not available here.</>
            : <>Could not load “{title}”.{' '}
              <button type="button" className="underline" onClick={() => { forgetInlineUiBlock(host, id); setData(null); setAttempt((n) => n + 1); }}>Retry</button></>}
        </div>
      )}
      {data && 'block' in data && <LoadedBlock block={data.block} host={host} />}
    </section>
  );
}

function LoadedBlock({ block, host }: { block: InlineUiBlockData; host: InlineUiHost }) {
  const skipId = useId();
  const [run, setRun] = useState<RunState>(() => initialRun(block, host));
  const [mountKey, setMountKey] = useState(0);
  const [height, setHeight] = useState(() => clampInlineUiHeight(block.heightHint, typeof window !== 'undefined' ? window.innerHeight : undefined));
  const [errors, setErrors] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [blank, setBlank] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [showSource, setShowSource] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameEl = useRef<HTMLIFrameElement | null>(null);
  const reported = useRef(new Set<InlineUiOutcome>());
  const mode = block.scripts && run.kind === 'running' ? 'scripted' : 'static';
  const showFrame = run.kind === 'running' || (run.kind === 'waiting' && run.reason !== 'froze');

  const report = useCallback((outcome: InlineUiOutcome, extra: { errorClass?: InlineUiErrorClass; line?: number } = {}) => {
    if (reported.current.has(outcome)) return;
    reported.current.add(outcome);
    host.report?.({ id: block.id, outcome, ...extra });
  }, [host, block.id]);

  useEffect(() => { if (run.kind === 'waiting' && run.reason === 'froze') report('froze'); }, [run, report]);

  // Freeze marker and live-frame cap, while a frame is mounted.
  useEffect(() => {
    if (!showFrame) return;
    const key = `${block.id}:${mountKey}`;
    setMarker(block.id, true);
    live.set(key, { lastVisible: Date.now(), visible: true, pause: () => setRun({ kind: 'paused' }) });
    enforceCap(key);
    const el = containerRef.current;
    const observer = el && typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => {
        const rec = live.get(key);
        if (rec) { rec.visible = entry.isIntersecting; if (entry.isIntersecting) rec.lastVisible = Date.now(); }
      })
      : null;
    if (el) observer?.observe(el);
    return () => {
      observer?.disconnect();
      live.delete(key);
      setMarker(block.id, false);
    };
  }, [showFrame, block.id, mountKey]);

  // Focus guard (S14): focus that lands in the frame while the user is
  // typing on this page (a key other than Tab within the last second), or
  // with no user activation at all (a click inside a frame activates this
  // page; a script's focus() does not), was taken by the frame's script —
  // give it back and stop the block.
  useEffect(() => {
    if (run.kind !== 'running') return;
    const frame = frameEl.current;
    if (!frame) return;
    const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    let lastTab = 0;
    let lastKey = 0;
    let previous: Element | null = document.activeElement;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Tab') lastTab = Date.now(); else lastKey = Date.now(); };
    const onFocusIn = () => { previous = document.activeElement; };
    const onBlur = () => {
      setTimeout(() => {
        if (document.activeElement !== frame) return;
        const now = Date.now();
        if (now - lastTab < 1000) return;
        const typing = now - lastKey < 1000;
        if (!typing && (!activation || activation.isActive)) return;
        if (previous instanceof HTMLElement) previous.focus();
        setRun({ kind: 'stopped', why: 'It tried to take the keyboard focus.' });
      }, 0);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('blur', onBlur);
    };
  }, [run.kind, mountKey]);

  const onMessage = useCallback((m: InlineUiHostMessage) => {
    switch (m.type) {
      case 'height':
        if (!suggestion) setHeight(clampInlineUiHeight(m.height, window.innerHeight));
        return;
      case 'error':
        if (m.kind === 'removed') { setRemoved(m.items); return; }
        if (m.kind === 'blank') { setBlank(true); report('blank'); return; }
        setErrors((prev) => prev.length >= 5 ? prev : [...prev, `${m.errorClass}${m.line ? ` (line ${m.line})` : ''}`]);
        report('script-error', { errorClass: m.errorClass, line: m.line });
        return;
      case 'link':
        setLink(m.url);
        return;
      case 'prompt':
        if (!host.sendSuggestion && !host.editSuggestion) return;
        if (host.impersonating) return;
        setSuggestion({ text: m.text, at: Date.now() });
        return;
      case 'stopped':
        setRun({ kind: 'stopped', why: m.reason === 'navigation' ? `It tried to open ${m.host || 'another page'}.` : 'It sent too many messages.' });
        report(m.reason === 'navigation' ? 'stopped-navigation' : 'stopped-flood');
        return;
      case 'ready':
        return;
    }
  }, [host, report, suggestion]);

  // Saving is a user action under the user's own session (§7): not for an
  // answer made after reading content from outside, not while impersonating.
  const [saving, setSaving] = useState(false);
  const saveRefusal = block.tainted
    ? 'made after reading content from outside, so it cannot be saved'
    : host.impersonating ? 'off while acting as another user' : null;

  const restart = () => {
    setErrors([]); setRemoved([]); setBlank(false); setLink(null); setSuggestion(null);
    reported.current.clear();
    setRun({ kind: 'running' });
    setMountKey((k) => k + 1);
  };

  // Buttons drawn next to the frame ignore input for a moment after they
  // appear, so a click aimed inside the frame cannot land on them (S6).
  const settled = (since: number) => Date.now() - since >= INLINE_UI_LIMITS.inputDelayMs;

  return (
    <div ref={containerRef}>
      <a href={`#${skipId}`} className="sr-only focus:not-sr-only focus:block focus:px-3 focus:py-1 text-xs">Skip interactive answer</a>
      <header className="flex items-center gap-2 px-3 py-1.5 border-b border-outline-variant/30 text-xs text-on-surface-variant">
        <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden />
        <h3 className="font-medium text-on-surface truncate text-xs">{block.title}</h3>
        <span className="shrink-0">Interactive answer</span>
        {block.scripts && <span className="shrink-0 hidden sm:inline">· resets when reloaded</span>}
        <span className="ml-auto flex items-center gap-1 shrink-0">
          <button type="button" title="View source" aria-pressed={showSource} onClick={() => setShowSource((v) => !v)} className="p-1 rounded hover:bg-surface-container-high"><Code2 className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">View source</span></button>
          {run.kind !== 'waiting' && (
            <button type="button" title="Restart" onClick={restart} className="p-1 rounded hover:bg-surface-container-high"><RotateCcw className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">Restart</span></button>
          )}
          {host.saveAsArtifact && (
            <button
              type="button"
              data-testid="inline-ui-save"
              title={saveRefusal ?? 'Save as artifact'}
              disabled={!!saveRefusal}
              onClick={() => setSaving(true)}
              className="p-1 rounded hover:bg-surface-container-high disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Save className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">{saveRefusal ? `Save as artifact: ${saveRefusal}` : 'Save as artifact'}</span>
            </button>
          )}
        </span>
      </header>
      {saving && host.saveAsArtifact && (
        <SaveAsArtifactDialog block={block} open onClose={() => setSaving(false)} save={(input) => host.saveAsArtifact!(block.id, input)} />
      )}

      {run.kind === 'waiting' && (
        <div className={cn('flex flex-wrap items-center gap-2 px-3 py-2 text-xs', run.high ? 'bg-error-container/30 text-on-surface' : 'text-on-surface-variant')} role="status">
          {run.high && <TriangleAlert className="h-4 w-4 text-error shrink-0" aria-hidden />}
          <span className="min-w-0">
            {run.high
              ? 'This conversation read credentials, or private data together with content from outside. Running this answer’s script could send what it shows out of this page.'
              : WAIT_TEXT[run.reason]}
          </span>
          {block.scripts || run.reason === 'froze' ? (
            <button type="button" data-testid="inline-ui-run" onClick={restart} className="ml-auto inline-flex items-center gap-1 rounded-md border border-outline px-2 py-1 text-on-surface hover:bg-surface-container-high">
              <Play className="h-3.5 w-3.5" aria-hidden /> {run.reason === 'froze' ? 'Show again' : 'Run interactive answer'}
            </button>
          ) : null}
        </div>
      )}

      {run.kind === 'paused' && (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-on-surface-variant">
          Paused while other interactive answers are on screen.
          <button type="button" onClick={restart} className="ml-auto underline">Show</button>
        </div>
      )}

      {run.kind === 'stopped' && (
        <div role="status" className="flex items-center gap-2 px-3 py-3 text-xs text-on-surface">
          <TriangleAlert className="h-4 w-4 text-error shrink-0" aria-hidden />
          <span>Stopped: {run.why}</span>
          <button type="button" onClick={restart} className="ml-auto underline">Run again</button>
        </div>
      )}

      {showFrame && (
        <div className="px-1 py-1 min-w-0" style={suggestion ? { height: `${height + 8}px` } : undefined}>
          <InlineUiFrame
            key={`${mountKey}:${mode}`}
            title={block.title}
            html={block.html}
            css={block.css}
            js={block.js}
            mode={mode}
            height={height}
            onMessage={onMessage}
            onFlood={() => { setRun({ kind: 'stopped', why: 'It sent too many messages.' }); report('stopped-flood'); }}
            frameRef={(el) => { frameEl.current = el; }}
          />
        </div>
      )}

      {(errors.length > 0 || blank || removed.length > 0) && (
        <div role="status" className="px-3 py-1.5 text-xs space-y-0.5">
          {errors.length > 0 && <p className="text-error">Script error: {errors.join(', ')}</p>}
          {blank && <p className="text-warning">This interactive answer showed nothing.</p>}
          {removed.length > 0 && <p className="text-on-surface-variant">Removed: {removed.map((r) => REMOVED_TEXT[r] ?? r).join(', ')}.</p>}
        </div>
      )}

      {link && <LinkChip url={link} onDismiss={() => setLink(null)} settled={settled} />}

      {suggestion && (
        <SuggestionStrip
          title={block.title}
          suggestion={suggestion}
          busy={!!host.busy}
          settled={settled}
          onSend={host.sendSuggestion ? () => { host.sendSuggestion?.(suggestion.text, block.id); setSuggestion(null); } : undefined}
          onEdit={host.editSuggestion ? () => { host.editSuggestion?.(suggestion.text, block.id); setSuggestion(null); } : undefined}
          onDismiss={() => setSuggestion(null)}
        />
      )}

      {showSource && (
        <pre className="mx-3 my-2 max-h-80 overflow-auto rounded bg-surface-container p-2 text-[11px] leading-snug whitespace-pre-wrap break-all" data-testid="inline-ui-source">
          {[block.css && `<style>\n${block.css}\n</style>`, block.html, block.js && `<script>\n${block.js}\n</script>`].filter(Boolean).join('\n')}
        </pre>
      )}

      <footer className="px-3 py-1 border-t border-outline-variant/30 text-[10px] text-on-surface-variant/80">
        Made by the agent · don’t enter passwords or keys here
      </footer>
      <span id={skipId} />
    </div>
  );
}

function LinkChip({ url, onDismiss, settled }: { url: string; onDismiss: () => void; settled: (since: number) => boolean }) {
  const [at] = useState(() => Date.now());
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-t border-outline-variant/30" data-testid="inline-ui-link">
      <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="text-on-surface-variant shrink-0">Link:</span>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="truncate text-primary underline"
        onClick={(e) => { if (!settled(at)) e.preventDefault(); }}
      >{url}</a>
      <button type="button" onClick={onDismiss} className="ml-auto p-0.5" aria-label="Dismiss link"><X className="h-3.5 w-3.5" aria-hidden /></button>
    </div>
  );
}

function SuggestionStrip({ title, suggestion, busy, settled, onSend, onEdit, onDismiss }: {
  title: string;
  suggestion: Suggestion;
  busy: boolean;
  settled: (since: number) => boolean;
  onSend?: () => void;
  onEdit?: () => void;
  onDismiss: () => void;
}) {
  const guard = (fn?: () => void) => () => { if (settled(suggestion.at)) fn?.(); };
  return (
    <div className="px-3 py-2 border-t border-outline-variant/30 text-xs space-y-1.5" data-testid="inline-ui-suggestion" role="group" aria-label="Suggested message">
      <p className="text-on-surface-variant">Suggested by “{title}” — {suggestion.text.length} characters:</p>
      <div className="max-h-32 overflow-auto rounded bg-surface-container px-2 py-1.5 whitespace-pre-wrap break-words text-on-surface">{suggestion.text}</div>
      <div className="flex flex-wrap gap-2">
        {onSend && (
          <button type="button" onClick={guard(onSend)} className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-on-primary">
            <Send className="h-3.5 w-3.5" aria-hidden /> {busy ? 'Send as guidance' : 'Send'}
          </button>
        )}
        {onEdit && <button type="button" onClick={guard(onEdit)} className="rounded-md border border-outline px-2 py-1">Edit in composer</button>}
        <button type="button" onClick={onDismiss} className="rounded-md px-2 py-1 text-on-surface-variant">Dismiss</button>
      </div>
    </div>
  );
}

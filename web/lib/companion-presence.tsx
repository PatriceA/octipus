'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CompanionAppearance, CompanionState } from '../../src/shared/companion';
import { companionFrames } from '../../src/shared/companion-frames';
import {
  applyPresenceSnapshot, emptyPresence, momentTitle, nextPresenceChange, type PresenceMoment, type PresenceState,
  presenceLabel, presenceState, reducePresence,
} from '../../src/shared/companion-presence';
import { api } from './api';
import { useAuth } from './auth-context';
import { getCompanionPrefs, useCompanionPrefs } from './companion-prefs';
import { iconDataUrl, iconPngBytes } from './companion-icon';
import { useGatewayMessages, useGatewayStatus } from './gateway-context';
import { isDesktop } from './tauri-backend';
import { notifyDesktop, updateTray } from './tauri-companion';

/**
 * The companion outside the chat page. Follows every conversation of the user
 * over the tab's gateway connection (`src/shared/companion-presence.ts`) and
 * shows it where the user is: the animated tab icon and an unseen count in
 * the title, system notifications when a turn finishes, fails or needs an
 * answer, and — in the desktop app — the animated tray icon.
 */

type NotificationPermissionState = NotificationPermission | 'unsupported';

interface CompanionPresenceValue {
  state: CompanionState;
  label: string;
  name: string;
  appearance?: CompanionAppearance;
  /** The browser's notification permission; the desktop app always reports `granted`. */
  permission: NotificationPermissionState;
  /** Ask the browser for permission (needs a click). Resolves to the new state. */
  requestPermission: () => Promise<NotificationPermissionState>;
  /** Send a sample notification, ignoring "only when away", to check the OS setup. */
  testNotification: () => Promise<void>;
}

const CompanionPresenceContext = createContext<CompanionPresenceValue | null>(null);

export function useCompanionPresence(): CompanionPresenceValue | null {
  return useContext(CompanionPresenceContext);
}

/** The chat page's own key for the conversation it has open (`app/chat/page.tsx`). */
const CHAT_ACTIVE_SESSION_KEY = 'chat_active_session';
/** Event ids already notified, shared by the user's tabs so only one of them speaks up. */
const NOTIFIED_KEY = 'octipus.companion.notified';

function browserPermission(): NotificationPermissionState {
  if (isDesktop()) return 'granted';
  return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported';
}

/** Is the user looking at this moment's conversation right now? */
function isOnScreen(sessionId: string | undefined): boolean {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return false;
  if (!sessionId) return true;
  let active: string | null = null;
  try {
    active = localStorage.getItem(CHAT_ACTIVE_SESSION_KEY);
  } catch (err) {
    console.warn('could not read the open conversation; treating the moment as off screen', err);
  }
  return window.location.pathname === '/chat' && active === sessionId;
}

/** First tab to claim an event notifies; the others stay quiet. */
function claim(eventId: string): boolean {
  try {
    const seen = JSON.parse(localStorage.getItem(NOTIFIED_KEY) ?? '[]') as string[];
    if (seen.includes(eventId)) return false;
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify([...seen, eventId].slice(-100)));
  } catch (err) {
    console.warn('notification de-duplication unavailable; this tab notifies anyway', err);
  }
  return true;
}

let audio: AudioContext | null = null;

/** Two soft notes: rising when done, a double tap when it needs you, falling on failure. */
function chime(kind: PresenceMoment['kind']): void {
  try {
    audio ??= new AudioContext();
    const notes = kind === 'done' ? [660, 880] : kind === 'needs_input' ? [740, 740] : [520, 392];
    const start = audio.currentTime + .02;
    notes.forEach((frequency, i) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const at = start + i * .16;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(.12, at + .02);
      gain.gain.exponentialRampToValueAtTime(.001, at + .28);
      osc.connect(gain).connect(audio!.destination);
      osc.start(at);
      osc.stop(at + .3);
    });
  } catch (err) {
    console.warn('companion chime could not play', err);
  }
}

export function CompanionPresenceProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const gatewayStatus = useGatewayStatus();
  const prefs = useCompanionPrefs();
  const router = useRouter();
  const { data: persona } = useQuery({
    queryKey: ['persona', 'me'],
    queryFn: () => api.get<{ name?: string; appearance?: CompanionAppearance }>('/persona'),
    enabled: isAuthenticated,
  });
  const name = persona?.name || 'Octipus';
  const appearance = persona?.appearance;

  const [presence, setPresence] = useState<PresenceState>(() => emptyPresence(Date.now()));
  /** Exact, event by event; `presence` is the render snapshot, refreshed on visible changes. */
  const presenceRef = useRef<PresenceState>(presence);
  const [now, setNow] = useState(() => Date.now());
  const [unseen, setUnseen] = useState(0);
  const [permission, setPermission] = useState<NotificationPermissionState>(browserPermission);

  const connected = gatewayStatus !== 'disconnected' && gatewayStatus !== 'too_many_tabs';
  const state = presenceState(presence, now, connected);
  const label = presenceLabel(name, presence, now, connected);

  const show = useCallback(async (title: string, body: string, sessionId: string | undefined, kind: PresenceMoment['kind'], tag: string) => {
    if (getCompanionPrefs().sound) chime(kind);
    if (isDesktop()) {
      await notifyDesktop(title, body);
      return;
    }
    if (browserPermission() !== 'granted') return;
    const icon = await iconDataUrl(companionFrames(appearance, kind === 'done' ? 'done' : kind === 'needs_input' ? 'waiting' : 'interrupted').frames.at(-1)!, 128);
    const notification = new Notification(title, { body, tag, icon });
    notification.onclick = () => {
      window.focus();
      router.push(sessionId ? `/chat?session=${encodeURIComponent(sessionId)}` : '/chat');
      notification.close();
    };
  }, [appearance, router]);

  const onMoment = useCallback((moment: PresenceMoment) => {
    const current = getCompanionPrefs();
    const away = !isOnScreen(moment.sessionId);
    // The title counts only what happened while the window itself was away: focus clears it.
    if (document.visibilityState !== 'visible' || !document.hasFocus()) setUnseen(count => count + 1);
    if (!current.notify) return;
    const wanted = moment.kind === 'done' ? current.notifyDone : moment.kind === 'needs_input' ? current.notifyInput : current.notifyFailed;
    if (!wanted || (current.onlyWhenAway && !away) || !claim(moment.eventId)) return;
    void show(momentTitle(name, moment.kind), moment.detail, moment.sessionId, moment.kind, `${moment.kind}:${moment.sessionId ?? 'all'}`)
      .catch(err => console.warn('companion notification failed', err));
  }, [name, show]);

  useGatewayMessages((message) => {
    if (message.type === 'permission.pending') {
      presenceRef.current = applyPresenceSnapshot(presenceRef.current, message);
    } else if (message.type === 'event') {
      const at = Date.now();
      const before = presenceLabel(name, presenceRef.current, at, connected);
      const { state: next, moment } = reducePresence(presenceRef.current, message.event, at);
      presenceRef.current = next;
      if (moment) onMoment(moment);
      // A streaming turn sends many events that change nothing visible: re-render only on a change.
      // The ref stays exact; `presence` catches up on the next visible change or timer.
      if (!moment && presenceLabel(name, next, at, connected) === before) return;
      setNow(at);
    } else {
      return;
    }
    setPresence(presenceRef.current);
  });

  // Wake for transitions that happen without an event: the cheer ending, dozing off.
  useEffect(() => {
    const at = nextPresenceChange(presence, now);
    if (at == null) return;
    const timer = setTimeout(() => {
      setPresence(presenceRef.current);
      setNow(Date.now());
    }, Math.max(250, at - Date.now()));
    return () => clearTimeout(timer);
  }, [presence, now]);

  // Coming back clears the unseen count.
  useEffect(() => {
    const seen = () => { if (document.visibilityState === 'visible' && document.hasFocus()) setUnseen(0); };
    window.addEventListener('focus', seen);
    document.addEventListener('visibilitychange', seen);
    return () => {
      window.removeEventListener('focus', seen);
      document.removeEventListener('visibilitychange', seen);
    };
  }, []);

  useTabIcon(prefs.tabIcon && isAuthenticated ? state : null, appearance, unseen);
  useTray(isAuthenticated ? state : null, appearance, label);

  const requestPermission = useCallback(async () => {
    if (browserPermission() === 'unsupported' || isDesktop()) return browserPermission();
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }, []);

  const testNotification = useCallback(
    () => show(`${name} says hello`, 'Notifications are on. I’ll let you know when work is done or I need you.', undefined, 'done', 'test'),
    [name, show],
  );

  const value = useMemo<CompanionPresenceValue>(() => ({ state, label, name, appearance, permission, requestPermission, testNotification }),
    [state, label, name, appearance, permission, requestPermission, testNotification]);

  return <CompanionPresenceContext.Provider value={value}>{children}</CompanionPresenceContext.Provider>;
}

/** States worth taking over the brand favicon for; calm states leave it alone. */
const TAB_ICON_STATES = new Set<CompanionState>(['working', 'waiting', 'done', 'interrupted']);

/** The tab icon follows the companion, and the title counts what happened while away. */
function useTabIcon(state: CompanionState | null, appearance: CompanionAppearance | undefined, unseen: number) {
  const baseTitle = useRef<string | null>(null);

  useEffect(() => {
    baseTitle.current ??= document.title;
    document.title = unseen > 0 ? `(${unseen}) ${baseTitle.current}` : baseTitle.current;
  }, [unseen]);

  useEffect(() => {
    if (!state || !TAB_ICON_STATES.has(state)) return;
    const originals = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    for (const link of originals) link.remove();
    const link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/png';
    link.dataset.companion = state;
    document.head.appendChild(link);
    const { frames, intervalMs, loop } = companionFrames(appearance, state);
    let index = 0;
    let cancelled = false;
    const draw = () => {
      void iconDataUrl(frames[index], 32)
        .then(url => { if (!cancelled) link.href = url; })
        .catch(err => console.warn('companion tab icon failed to render', err));
    };
    draw();
    const timer = frames.length > 1 ? setInterval(() => {
      if (!loop && index === frames.length - 1) return;
      index = (index + 1) % frames.length;
      draw();
    }, intervalMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      link.remove();
      for (const original of originals) document.head.appendChild(original);
    };
  }, [state, appearance]);
}

/** Desktop: hand the Rust side the frames of the current state and the status line. */
function useTray(state: CompanionState | null, appearance: CompanionAppearance | undefined, label: string) {
  useEffect(() => {
    if (!isDesktop() || !state) return;
    let cancelled = false;
    const { frames, intervalMs, loop } = companionFrames(appearance, state);
    // Coalesce bursts of state changes into one IPC call.
    const timer = setTimeout(() => {
      void Promise.all(frames.map(svg => iconPngBytes(svg, 64)))
        .then(pngs => (cancelled ? undefined : updateTray({ frames: pngs, intervalMs, loop, status: label })))
        .catch(err => console.warn('companion tray update failed', err));
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state, appearance, label]);
}

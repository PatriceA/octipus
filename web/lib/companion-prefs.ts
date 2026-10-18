'use client';

import { useSyncExternalStore } from 'react';
import { isDesktop } from './tauri-backend';

/**
 * How the companion reaches the user outside the chat: system notifications,
 * a chime, and the animated tab icon. Per device (localStorage), not per
 * account — a laptop and a phone want different things, and the browser's
 * notification permission is per device anyway.
 */
export interface CompanionPrefs {
  /** Master switch for system notifications. */
  notify: boolean;
  notifyDone: boolean;
  notifyInput: boolean;
  notifyFailed: boolean;
  /** Only notify when the conversation isn't on screen. */
  onlyWhenAway: boolean;
  /** A short chime with each notification. */
  sound: boolean;
  /** Animate the tab icon and count unseen moments in the title. */
  tabIcon: boolean;
}

const KEY = 'octipus.companion.prefs';

/** The desktop app owns its notifications; a browser needs the user to opt in (a permission prompt). */
export const DEFAULT_COMPANION_PREFS: CompanionPrefs = {
  notify: isDesktop(),
  notifyDone: true,
  notifyInput: true,
  notifyFailed: true,
  onlyWhenAway: true,
  sound: false,
  tabIcon: true,
};

const listeners = new Set<() => void>();
let cached: CompanionPrefs | null = null;

function read(): CompanionPrefs {
  if (cached) return cached;
  let stored: Partial<CompanionPrefs> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as Partial<CompanionPrefs>;
  } catch (err) {
    console.warn('companion preferences unreadable; using defaults', err);
  }
  const merged = { ...DEFAULT_COMPANION_PREFS };
  for (const key of Object.keys(merged) as Array<keyof CompanionPrefs>) {
    if (typeof stored[key] === 'boolean') merged[key] = stored[key];
  }
  cached = merged;
  return merged;
}

export function getCompanionPrefs(): CompanionPrefs {
  return typeof window === 'undefined' ? DEFAULT_COMPANION_PREFS : read();
}

export function setCompanionPrefs(patch: Partial<CompanionPrefs>): void {
  cached = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch (err) {
    console.warn('companion preferences not saved; they last until this tab closes', err);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab changed them.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    cached = null;
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useCompanionPrefs(): CompanionPrefs {
  return useSyncExternalStore(subscribe, getCompanionPrefs, () => DEFAULT_COMPANION_PREFS);
}

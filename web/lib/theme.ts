'use client';
import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
function subscribe(listener: () => void) {
  window.addEventListener('octipus-theme-applied', listener);
  return () => window.removeEventListener('octipus-theme-applied', listener);
}
export function setTheme(preference: ThemePreference) {
  localStorage.setItem('octipus-theme', preference);
  window.dispatchEvent(new Event('octipus-theme-change'));
}
export function useTheme() {
  const preference = useSyncExternalStore(subscribe, () => document.documentElement.dataset.themePreference ?? 'system', () => 'system');
  const dark = useSyncExternalStore(subscribe, () => document.documentElement.classList.contains('dark'), () => false);
  return { preference, dark, setTheme };
}

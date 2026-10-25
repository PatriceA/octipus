'use client';

import { useState } from 'react';
import { type CompanionPrefs, setCompanionPrefs, useCompanionPrefs } from '@/lib/companion-prefs';
import { useCompanionPresence } from '@/lib/companion-presence';
import { isDesktop } from '@/lib/tauri-backend';
import { CompanionAvatar } from './companion-avatar';

const MOMENTS: Array<{ key: keyof CompanionPrefs; label: string }> = [
  { key: 'notifyDone', label: 'Work is done' },
  { key: 'notifyInput', label: 'A question or approval needs me' },
  { key: 'notifyFailed', label: 'Something went wrong' },
];

/** Per-device settings for how the companion reaches you outside the chat. */
export function PresenceSettings({ name }: { name: string }) {
  const prefs = useCompanionPrefs();
  const presence = useCompanionPresence();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const desktop = isDesktop();
  const permission = presence?.permission ?? 'unsupported';
  const blocked = !desktop && (permission === 'denied' || permission === 'unsupported');

  async function toggleNotify(on: boolean) {
    setError(null);
    setNotice('');
    if (on && !desktop && permission !== 'granted') {
      const result = await presence?.requestPermission();
      if (result !== 'granted') {
        setError(result === 'unsupported'
          ? 'This browser does not support notifications. Install the desktop app or add Octipus to your home screen.'
          : 'Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.');
        return;
      }
    }
    setCompanionPrefs({ notify: on });
  }

  async function test() {
    setError(null);
    try {
      await presence?.testNotification();
      setNotice('Sent. If nothing appeared, check your system’s notification settings (Focus / Do Not Disturb).');
    } catch (err) {
      setError(`Could not show a notification: ${(err as Error).message}`);
    }
  }

  return (
    <section className="rounded-xl term-frame p-5" aria-labelledby="companion-presence-title">
      <h2 id="companion-presence-title" className="mb-2 section-label">Presence & notifications</h2>
      <p className="text-xs text-on-surface-variant">
        Let {name} reach you while you are elsewhere. These settings belong to this {desktop ? 'computer' : 'browser'}.
      </p>

      {presence && (
        <div className="my-4 flex items-center gap-3 rounded-lg bg-companion-paper text-on-companion-paper p-3" data-testid="presence-now">
          <CompanionAvatar appearance={presence.appearance} size={44} state={presence.state} />
          <span role="status" className="text-sm">{presence.label}</span>
        </div>
      )}

      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={prefs.notify && !blocked} onChange={e => void toggleNotify(e.target.checked)} />
          System notifications
        </label>
        <fieldset disabled={!prefs.notify || blocked} className="ml-6 space-y-2 disabled:opacity-50">
          <legend className="sr-only">Notify me when</legend>
          {MOMENTS.map(moment => (
            <label key={moment.key} className="flex items-center gap-2">
              <input type="checkbox" checked={prefs[moment.key]} onChange={e => setCompanionPrefs({ [moment.key]: e.target.checked })} />
              {moment.label}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={prefs.onlyWhenAway} onChange={e => setCompanionPrefs({ onlyWhenAway: e.target.checked })} />
            Only when that conversation isn’t on screen
          </label>
          <button type="button" onClick={() => void test()} className="rounded-xl border border-outline-variant px-3 py-1 text-xs">
            Send a test notification
          </button>
        </fieldset>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={prefs.sound} onChange={e => setCompanionPrefs({ sound: e.target.checked })} />
          Play a soft chime
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={prefs.tabIcon} onChange={e => setCompanionPrefs({ tabIcon: e.target.checked })} />
          Show status in the tab icon and count what happened while I was away
        </label>
      </div>

      {notice && <p role="status" className="mt-3 text-xs text-on-surface-variant">{notice}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-error">{error}</p>}
      <p className="mt-3 text-xs text-on-surface-variant">
        {desktop
          ? 'The tray icon shows what your companion is doing. Closing the window keeps it running in the tray; mute notifications or quit from the tray menu.'
          : 'Want a tray icon and native notifications that work with the window closed? Use the desktop app (octi desktop).'}
      </p>
    </section>
  );
}

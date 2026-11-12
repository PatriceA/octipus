'use client';
import { useState } from 'react';
import { type ThemePreference, useTheme } from '@/lib/theme';

export function AppearanceTab() {
  const { preference, setTheme } = useTheme();
  const [error, setError] = useState('');
  return <div className="space-y-4">
    <h2>Appearance</h2>
    <p className="text-sm text-on-surface-variant">Choose a comfortable workspace. Your choice is saved in this browser and also applies to the sign-in screen.</p>
    <label className="block text-sm" htmlFor="workspace-theme">Color theme</label>
    <select id="workspace-theme" className="bg-surface-container-high border border-outline-variant text-on-surface p-3" value={preference} onChange={event => {
      try { setTheme(event.target.value as ThemePreference); setError(''); }
      catch { setError('Could not save your theme. Check whether browser storage is enabled.'); }
    }}>
      <option value="system">Follow device</option><option value="dark">Dark</option><option value="light">Light</option>
    </select>
    {error && <p role="alert" className="text-error text-sm">{error}</p>}
  </div>;
}

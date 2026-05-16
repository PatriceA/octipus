'use client';

import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

const inputClass =
  'w-full px-3 py-2 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary transition-colors';
const labelClass = 'block text-[10px] uppercase tracking-wider text-outline-variant mb-1';

export interface ChannelsStepProps {
  telegramToken: string;
  setTelegramToken: (v: string) => void;
  telegramAllowedUsers: string;
  setTelegramAllowedUsers: (v: string) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  setError: (v: string) => void;
}

export function ChannelsStep({
  telegramToken,
  setTelegramToken,
  telegramAllowedUsers,
  setTelegramAllowedUsers,
  saving,
  setSaving,
  setError,
}: ChannelsStepProps) {
  const saveChannelSettings = async () => {
    setSaving(true);
    setError('');
    try {
      if (telegramToken) {
        await api.put(`/settings/${encodeURIComponent('telegram.botToken')}`, { value: telegramToken });
      }
      if (telegramAllowedUsers) {
        await api.put(`/settings/${encodeURIComponent('telegram.allowedUsers')}`, {
          value: telegramAllowedUsers
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        });
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[14px] text-on-surface flex items-center gap-2">
          <span className="text-primary" aria-hidden>❯</span>
          channels <span className="text-outline-variant text-[11px] uppercase tracking-wider">[optional]</span>
        </h2>
        <p className="text-[12px] text-on-surface-variant mt-1">
          connect messaging channels. skip to configure later.
        </p>
      </div>

      <div>
        <label className={labelClass}>telegram bot token</label>
        <input
          type="password"
          value={telegramToken}
          onChange={(e) => setTelegramToken(e.target.value)}
          placeholder="123456:ABC-DEF..."
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>telegram allowed users <span className="text-outline normal-case">(optional)</span></label>
        <input
          type="text"
          value={telegramAllowedUsers}
          onChange={(e) => setTelegramAllowedUsers(e.target.value)}
          placeholder="user_id_1, user_id_2"
          className={inputClass}
        />
        <p className="text-[11px] text-outline mt-1">
          comma-separated telegram user ids. empty = allow all.
        </p>
      </div>

      {telegramToken && (
        <button
          onClick={saveChannelSettings}
          disabled={saving}
          className="px-3 py-1.5 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '❯ save channel settings'}
        </button>
      )}
    </div>
  );
}

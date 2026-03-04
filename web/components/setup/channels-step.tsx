'use client';

import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

const inputClasses =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-primary-500';

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
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Channels (Optional)</h2>
      <p className="text-sm text-gray-500">Connect messaging channels. You can skip this and configure later.</p>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Telegram Bot Token</label>
        <input
          type="password"
          value={telegramToken}
          onChange={(e) => setTelegramToken(e.target.value)}
          placeholder="123456:ABC-DEF..."
          className={inputClasses}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
          Telegram Allowed Users (optional)
        </label>
        <input
          type="text"
          value={telegramAllowedUsers}
          onChange={(e) => setTelegramAllowedUsers(e.target.value)}
          placeholder="user_id_1, user_id_2"
          className={inputClasses}
        />
        <p className="text-xs text-gray-500 mt-1">Comma-separated Telegram user IDs. Leave empty to allow all users.</p>
      </div>

      {telegramToken && (
        <button
          onClick={saveChannelSettings}
          disabled={saving}
          className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Channel Settings'}
        </button>
      )}
    </div>
  );
}

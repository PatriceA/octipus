'use client';

import { Loader2, ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';

const inputClasses =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-primary-500';

export interface AccountStepProps {
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  email: string;
  setEmail: (v: string) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  setError: (v: string) => void;
  onCompleteSetup: () => void;
}

export function AccountStep({
  username,
  setUsername,
  password,
  setPassword,
  email,
  setEmail,
  saving,
  setSaving,
  setError,
  onCompleteSetup,
}: AccountStepProps) {
  const createAccount = async () => {
    if (!username || !password) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.post<{ token?: string; error?: string }>('/auth/register', {
        username,
        password,
        email: email || undefined,
      });
      if (res.error) {
        setError(res.error);
      } else if (res.token) {
        api.setToken(res.token);
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Create Admin Account</h2>
      <p className="text-sm text-gray-500">
        The first registered user becomes the admin. If you already have an account, skip this step.
      </p>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Username</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="admin"
          className={inputClasses}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Choose a strong password"
          className={inputClasses}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email (optional)</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@example.com"
          className={inputClasses}
        />
      </div>

      <div className="flex gap-2">
        {username && password && (
          <button
            onClick={createAccount}
            disabled={saving}
            className="px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create Account'}
          </button>
        )}
        <button
          onClick={onCompleteSetup}
          disabled={saving}
          className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 flex items-center gap-2"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Complete Setup'}
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

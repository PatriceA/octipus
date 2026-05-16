'use client';

import { ArrowRight, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

const inputClass =
  'w-full px-3 py-2 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary transition-colors';
const labelClass = 'block text-[10px] uppercase tracking-wider text-outline-variant mb-1';

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
      <div>
        <h2 className="text-[14px] text-on-surface flex items-center gap-2">
          <span className="text-primary" aria-hidden>❯</span>
          create admin account
        </h2>
        <p className="text-[12px] text-on-surface-variant mt-1">
          first registered user becomes admin. skip if you already have an account.
        </p>
      </div>

      <div>
        <label className={labelClass}>username</label>
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="admin"
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="choose a strong password"
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>email (optional)</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="admin@example.com"
          className={inputClass}
        />
      </div>

      <div className="flex gap-2">
        {username && password && (
          <button
            onClick={createAccount}
            disabled={saving}
            className="px-3 py-1.5 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '❯ create account'}
          </button>
        )}
        <button
          onClick={onCompleteSetup}
          disabled={saving}
          className="px-3 py-1.5 text-[12px] bg-tertiary text-on-tertiary rounded-xs hover:bg-tertiary-dim disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'complete setup'}
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

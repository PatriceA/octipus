'use client';

import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { isSafeReturnTo } from '../../../src/shared/return-to';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';

// The desktop client is cross-origin to the backend, so the HttpOnly session
// cookie set by `/auth/login` is never sent back (SameSite) — auth silently
// fails. Native clients use `/auth/login-mobile`, which returns a bearer token
// in the body that the api client stores and sends via the Authorization
// header (cross-origin safe). Baked at build time (see next.config.mjs).
const IS_DESKTOP_BUILD = process.env.NEXT_PUBLIC_DESKTOP_BUILD === '1';
const LOGIN_ENDPOINT = IS_DESKTOP_BUILD ? '/auth/login-mobile' : '/auth/login';

interface SignInResponse {
  token?: string;
  user?: { id: string; username: string; isAdmin: boolean };
  returnTo?: string;
  error?: string;
}

/** A 401 that asks for the second factor rather than rejecting the password. */
function isTotpChallenge(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && err.body.requiresTOTP === true;
}

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  // `?returnTo=` is attacker-controllable; anything but a same-origin path is
  // ignored. Captured once: the server echoes back what it validated.
  const searchParams = useSearchParams();
  const requestedReturnTo = searchParams.get('returnTo');
  const [returnTo] = useState(() => (isSafeReturnTo(requestedReturnTo) ? requestedReturnTo : undefined));
  // `?mode=register` opens on the register tab (the invite page's Register link).
  const [isLogin, setIsLogin] = useState(() => searchParams.get('mode') !== 'register');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');

  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      if (!isLogin && formData.password !== formData.confirmPassword) {
        setError('passwords do not match');
        setIsLoading(false);
        return;
      }

      const endpoint = isLogin ? LOGIN_ENDPOINT : '/auth/register';
      const body = isLogin
        ? { username: formData.username, password: formData.password, returnTo }
        : { username: formData.username, email: formData.email, password: formData.password, returnTo };

      let data: SignInResponse;
      try {
        data = await api.post<SignInResponse>(endpoint, body);
      } catch (err) {
        // The password was right and the account has TOTP on: the server
        // answers 401 `{ requiresTOTP: true }`; ask for the code and resubmit.
        if (isLogin && isTotpChallenge(err)) {
          setTotpRequired(true);
          return;
        }
        throw err;
      }

      if (data.error) throw new Error(data.error);

      if (data.user) {
        // Desktop registration creates a cookie-only session; exchange the
        // credentials for a bearer token so cross-origin requests authenticate.
        let token = data.token || '';
        if (IS_DESKTOP_BUILD && !token && !isLogin) {
          const m = await api.post<{ token?: string }>('/auth/login-mobile', {
            username: formData.username,
            password: formData.password,
          });
          token = m.token || '';
        }
          login(token, {
          id: data.user.id,
          username: data.user.username,
          isAdmin: data.user.isAdmin,
        });
        router.push(data.returnTo ?? '/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTotpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      const data = await api.post<SignInResponse>(LOGIN_ENDPOINT, {
        username: formData.username,
        password: formData.password,
        totpCode,
        returnTo,
      });
      if (data.error) throw new Error(data.error);
      if (data.user) {
        login(data.token || '', {
          id: data.user.id,
          username: data.user.username,
          isAdmin: data.user.isAdmin,
        });
        router.push(data.returnTo ?? '/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'verification failed');
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary transition-colors';
  const labelClass = 'block text-[10px] uppercase tracking-wider text-outline-variant mb-1';

  return (
    <div className="relative min-h-screen bg-background flex items-center justify-center p-4 font-mono overflow-hidden">
      {/* CRT backdrop layers — dotted neural grid under a scanline wash. */}
      <div aria-hidden className="absolute inset-0 neural-grid" />
      <div aria-hidden className="absolute inset-0 crt-scanlines" />
      <div className="relative w-full max-w-md animate-enter">
        {/* Boot-style banner. ASCII frame around the title so the login
            page introduces the design language up-front. */}
        <pre className="text-primary text-[10px] leading-tight mb-3 select-none" aria-hidden>
{`┌─[ octipus :: terminal ]─────────────────┐
│  multi-agent assistant                  │
│  multi-channel · multi-provider         │
└─────────────────────────────────────────┘`}
        </pre>
        {/* Path-style brand — `octi:~ $▍` plus the current auth mode. */}
        <div className="mb-6 text-[13px]">
          <span className="text-outline font-semibold">octi:</span>
          <span className="text-on-surface">~</span>
          <span className="text-primary font-bold"> $</span>
          <span className="ml-2 text-on-surface-variant">
            {totpRequired ? 'two-factor verification' : isLogin ? 'sign in' : 'register'}
          </span>
          <span aria-hidden className="term-caret" />
        </div>

        {totpRequired ? (
          <div className="term-frame glow-accent p-4 space-y-3">
            <p className="text-[12px] text-on-surface-variant">
              enter the 6-digit code from your authenticator app.
            </p>
            <form onSubmit={handleTotpVerify} className="space-y-3">
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="w-full px-3 py-3 text-center text-2xl tracking-[0.5em] bg-surface-container-low border border-outline-variant/60 rounded-xs text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary"
                autoFocus
                required
              />
              {error && (
                <div className="px-2 py-1.5 border border-error/60 bg-error-container/40 rounded-xs text-[12px] text-error">
                  ! {error}
                </div>
              )}
              <button
                type="submit"
                disabled={isLoading || totpCode.length !== 6}
                className="w-full py-2 bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-[13px]"
              >
                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : '❯ verify'}
              </button>
              <button
                type="button"
                onClick={() => { setTotpRequired(false); setTotpCode(''); setError(''); }}
                className="w-full text-[12px] text-on-surface-variant hover:text-on-surface"
              >
                ← back to login
              </button>
            </form>
          </div>
        ) : (
          <div className="term-frame glow-accent">
            {/* Sign in / register tabs as bordered top-row buttons —
                terminal-app modal style. */}
            <div className="flex border-b border-outline-variant/60">
              <button
                onClick={() => setIsLogin(true)}
                className={cn(
                  'flex-1 py-2 text-center text-[12px] uppercase tracking-wider transition-colors border-r border-outline-variant/60',
                  isLogin
                    ? 'bg-primary-container/40 text-primary'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
                )}
              >
                sign in
              </button>
              <button
                onClick={() => setIsLogin(false)}
                className={cn(
                  'flex-1 py-2 text-center text-[12px] uppercase tracking-wider transition-colors',
                  !isLogin
                    ? 'bg-primary-container/40 text-primary'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'
                )}
              >
                register
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-4 space-y-3">
              <div>
                <label className={labelClass}>username</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  placeholder="alice"
                  className={inputClass}
                  required
                />
              </div>

              {!isLogin && (
                <div>
                  <label className={labelClass}>email</label>
                  <input
                    type="email"
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    placeholder="alice@example.com"
                    className={inputClass}
                    required={!isLogin}
                  />
                </div>
              )}

              <div>
                <label className={labelClass}>password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    placeholder="••••••••"
                    className={cn(inputClass, 'pr-9')}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-outline-variant hover:text-on-surface"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {!isLogin && (
                <div>
                  <label className={labelClass}>confirm password</label>
                  <input
                    type="password"
                    value={formData.confirmPassword}
                    onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                    placeholder="••••••••"
                    className={inputClass}
                    required={!isLogin}
                  />
                </div>
              )}

              {error && (
                <div className="px-2 py-1.5 border border-error/60 bg-error-container/40 rounded-xs text-[12px] text-error">
                  ! {error}
                </div>
              )}

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2 bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-[13px]"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {isLogin ? 'signing in…' : 'creating account…'}
                  </>
                ) : (
                  <>❯ {isLogin ? 'sign in' : 'create account'}</>
                )}
              </button>
            </form>
          </div>
        )}

        <p className="text-center text-[11px] text-outline mt-5">
          octipus · self-hosted · multi-provider
        </p>
      </div>
    </div>
  );
}

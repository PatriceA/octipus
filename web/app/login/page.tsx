'use client';

import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [_totpUserId, setTotpUserId] = useState('');

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
        setError('Passwords do not match');
        setIsLoading(false);
        return;
      }

      const endpoint = isLogin ? '/auth/login' : '/auth/register';
      const body = isLogin
        ? { username: formData.username, password: formData.password }
        : { username: formData.username, email: formData.email, password: formData.password };

      const data = await api.post<{
        token?: string;
        user?: { id: string; username: string; isAdmin: boolean };
        totpRequired?: boolean;
        error?: string;
      }>(endpoint, body);

      if (data.error) {
        throw new Error(data.error);
      }

      if (data.totpRequired) {
        setTotpRequired(true);
        setTotpUserId(formData.username);
        setIsLoading(false);
        return;
      }

      if (data.user) {
        login(data.token || '', {
          id: data.user.id,
          username: data.user.username,
          isAdmin: data.user.isAdmin,
        });
        router.push('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTotpVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    try {
      const data = await api.post<{
        token?: string;
        user?: { id: string; username: string; isAdmin: boolean };
        error?: string;
      }>('/auth/login', {
        username: formData.username,
        password: formData.password,
        totpCode,
      });
      if (data.error) throw new Error(data.error);
      if (data.user) {
        login(data.token || '', {
          id: data.user.id,
          username: data.user.username,
          isAdmin: data.user.isAdmin,
        });
        router.push('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#000000] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl mb-4 inline-flex items-center justify-center bg-gradient-to-br from-primary to-primary-container shadow-[0_0_30px_-5px_rgba(115,255,227,0.5)]">
            <img src="/logo.png" alt="Assistant" className="w-16 h-16 rounded-2xl object-contain" />
          </div>
          <h1 className="font-headline text-2xl font-extrabold tracking-tighter text-primary">Assistant</h1>
          <p className="text-on-surface-variant text-sm mt-1">Autonomous Development Agent</p>
        </div>

        {/* TOTP Verification */}
        {totpRequired ? (
          <div className="bg-surface-variant/60 backdrop-blur-[20px] border border-outline-variant/20 rounded-[1rem] shadow-[0_20px_60px_-15px_rgba(115,255,227,0.1)] p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Two-Factor Authentication</h2>
            <p className="text-sm text-on-surface-variant mb-4">Enter the 6-digit code from your authenticator app.</p>
            <form onSubmit={handleTotpVerify} className="space-y-4">
              <input
                type="text"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="w-full px-4 py-3 text-center text-2xl tracking-widest border border-outline-variant/10 rounded-lg bg-[#131313] text-white focus:ring-2 focus:ring-primary"
                autoFocus
                required
              />
              {error && (
                <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
                  <p className="text-sm text-[#ff716c]">{error}</p>
                </div>
              )}
              <button
                type="submit"
                disabled={isLoading || totpCode.length !== 6}
                className="w-full py-2 bg-primary-800 text-white font-medium rounded-lg hover:bg-primary-900 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Verify'}
              </button>
              <button
                type="button"
                onClick={() => { setTotpRequired(false); setTotpCode(''); setError(''); }}
                className="w-full py-2 text-sm text-on-surface-variant hover:text-white"
              >
                Back to login
              </button>
            </form>
          </div>
        ) : (

        /* Form */
        <div className="bg-surface-variant/60 backdrop-blur-[20px] border border-outline-variant/20 rounded-[1rem] shadow-[0_20px_60px_-15px_rgba(115,255,227,0.1)] p-6">
          <div className="flex mb-6">
            <button
              onClick={() => setIsLogin(true)}
              className={`flex-1 py-2 text-center font-medium rounded-lg transition-colors ${
                isLogin
                  ? 'bg-primary-800 text-white'
                  : 'text-on-surface-variant hover:bg-[#1a1a1a]'
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => setIsLogin(false)}
              className={`flex-1 py-2 text-center font-medium rounded-lg transition-colors ${
                !isLogin
                  ? 'bg-primary-800 text-white'
                  : 'text-on-surface-variant hover:bg-[#1a1a1a]'
              }`}
            >
              Register
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1">
                Username
              </label>
              <input
                type="text"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="Enter your username"
                className="w-full px-4 py-2 border border-outline-variant/10 rounded-lg bg-[#131313] text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                required
              />
            </div>

            {!isLogin && (
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="Enter your email"
                  className="w-full px-4 py-2 border border-outline-variant/10 rounded-lg bg-[#131313] text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                  required={!isLogin}
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-white/80 mb-1">
                Password
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  placeholder="Enter your password"
                  className="w-full px-4 py-2 pr-10 border border-outline-variant/10 rounded-lg bg-[#131313] text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-white"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {!isLogin && (
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1">
                  Confirm Password
                </label>
                <input
                  type="password"
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                  placeholder="Confirm your password"
                  className="w-full px-4 py-2 border border-outline-variant/10 rounded-lg bg-[#131313] text-white focus:ring-2 focus:ring-primary focus:border-transparent"
                  required={!isLogin}
                />
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
                <p className="text-sm text-[#ff716c]">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2 bg-primary-800 text-white font-medium rounded-lg hover:bg-primary-900 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {isLogin ? 'Signing in...' : 'Creating account...'}
                </>
              ) : (
                isLogin ? 'Sign In' : 'Create Account'
              )}
            </button>
          </form>

          {isLogin && (
            <div className="mt-4 text-center">
              <p className="text-sm text-on-surface-variant">
                Don't have an account? Switch to Register above.
              </p>
            </div>
          )}
        </div>
        )}

        {/* Footer */}
        <p className="text-center text-sm text-on-surface-variant mt-6">
          Powered by Ollama + Local LLMs
        </p>
      </div>
    </div>
  );
}

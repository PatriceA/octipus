'use client';

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { loginPathReturningTo } from '../../src/shared/return-to';
import { isPublicPath } from './public-routes';
import { api, ApiError } from './api';

interface User {
  id: string;
  username: string;
  isAdmin: boolean;
  /** Runs on the install's models; else only on its own (Settings → My models). */
  installModels?: boolean;
}

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (token: string, user: User) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  isAuthenticated: false,
  isLoading: true,
  login: () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  // Seed from localStorage at init so the synchronous read isn't a setState
  // inside the mount effect (react-hooks/set-state-in-effect).
  const [token, setToken] = useState<string | null>(() =>
    typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null
  );
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    api.setToken(null);
    localStorage.removeItem('assistant-user');
  }, []);

  const logout = useCallback(() => {
    clearSession();
    router.push('/login');
  }, [clearSession, router]);

  // Listen for auth:expired events from API client. On the sign-in page itself
  // a 401 is a wrong password or a TOTP prompt, and navigating would drop the
  // page's `returnTo`; on another public page (an invite) it is a visitor not
  // signed in yet; anywhere else, sign in again and come back here.
  useEffect(() => {
    const handleExpired = () => {
      clearSession();
      const { pathname, search } = window.location;
      if (isPublicPath(pathname)) return;
      router.push(loginPathReturningTo(pathname + search));
    };
    window.addEventListener('auth:expired', handleExpired);
    return () => window.removeEventListener('auth:expired', handleExpired);
  }, [clearSession, router]);

  const login = useCallback((newToken: string, newUser: User) => {
    if (newToken) {
      setToken(newToken);
      api.setToken(newToken);
    }
    setUser(newUser);
    localStorage.setItem('assistant-user', JSON.stringify(newUser));
  }, []);

  // Validate token on mount
  useEffect(() => {
    const existingToken = localStorage.getItem('auth_token');
    if (existingToken) {
      api.setToken(existingToken);
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // A busy backend has not invalidated the login. Keep the loading gate
    // closed and retry after its cooldown, without discarding credentials.
    const validate = async () => {
      try {
        const data = await api.get<User>('/auth/me');
        if (cancelled) return;
        setUser({ id: data.id, username: data.username, isAdmin: data.isAdmin, installModels: data.installModels });
        setIsLoading(false);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 429) {
          retryTimer = setTimeout(() => { void validate(); }, Math.max(1000, error.retryAfterMs) + Math.random() * 1000);
          return;
        }
        api.setToken(null);
        setToken(null);
        localStorage.removeItem('auth_token');
        localStorage.removeItem('assistant-user');
        setIsLoading(false);
      }
    };
    void validate();
    return () => { cancelled = true; clearTimeout(retryTimer); };
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isAuthenticated: !!user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

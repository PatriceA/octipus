'use client';

import { Bell, BookOpen, Brain, Cpu, KeyRound, Loader2, LogOut, MessageSquare, Search, Settings, User, Webhook, Wrench } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/utils';
import { WorkspacePicker } from './workspace-picker';

interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string;
  read: boolean;
  createdAt: string;
}

interface SearchResult {
  id: string;
  type: 'session' | 'hook' | 'model' | 'skill' | 'knowledge' | 'tool';
  title: string;
  subtitle: string;
  href: string;
}

const SEARCH_TYPE_META: Record<SearchResult['type'], { label: string; icon: typeof MessageSquare }> = {
  session: { label: 'sessions', icon: MessageSquare },
  hook: { label: 'hooks', icon: Webhook },
  model: { label: 'models', icon: Cpu },
  skill: { label: 'skills', icon: BookOpen },
  knowledge: { label: 'knowledge', icon: Brain },
  tool: { label: 'tools', icon: Wrench },
};

export function Header() {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  // Single source of truth for identity: the live auth context (backed by
  // /auth/me), NOT a separate localStorage copy. The old localStorage read
  // showed "guest" whenever the session came from a persisted cookie rather
  // than an in-tab login(), since only login() wrote 'assistant-user'.
  const { user, logout: authLogout } = useAuth();

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await api.get<{ notifications: Notification[] }>('/notifications');
      if (data?.notifications) {
        setNotifications(data.notifications);
        setUnreadCount(data.notifications.filter(n => !n.read).length);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    const handler = (event: CustomEvent) => {
      const notif = event.detail as Notification;
      setNotifications(prev => [notif, ...prev].slice(0, 50));
      setUnreadCount(prev => prev + 1);
    };
    window.addEventListener('notification:new' as any, handler as any);
    return () => window.removeEventListener('notification:new' as any, handler as any);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsProfileOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setIsNotifOpen(false);
      }
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      setShowResults(false);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const data = await api.get<{ results: SearchResult[] }>(
          `/search?q=${encodeURIComponent(searchQuery.trim())}&limit=10`
        );
        setSearchResults(data?.results || []);
        setShowResults(true);
      } catch {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setShowResults(false);
        searchInputRef.current?.blur();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleResultClick = (result: SearchResult) => {
    setShowResults(false);
    setSearchQuery('');
    setSearchResults([]);
    router.push(result.href);
  };

  const groupedResults = searchResults.reduce<Record<string, SearchResult[]>>((acc, result) => {
    if (!acc[result.type]) acc[result.type] = [];
    acc[result.type].push(result);
    return acc;
  }, {});

  const handleLogin = () => {
    router.push('/login');
    setIsProfileOpen(false);
  };

  const handleLogout = () => {
    setIsProfileOpen(false);
    authLogout();
  };

  const markRead = async (id: string) => {
    try {
      await api.post(`/notifications/${id}/read`);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch {}
  };

  const markAllRead = async () => {
    try {
      await api.post('/notifications/read-all');
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {}
  };

  return (
    <header className="h-12 sticky top-0 z-40 bg-surface-container-lowest/95 backdrop-blur-sm border-b border-outline-variant/40 px-3 shrink-0 flex items-center gap-3 font-mono">
      {/* Command-line style search. The leading `❯` doubles as the
          focus indicator: blue when something's typed, dim otherwise.
          The bar is a single-line frame — no rounded pill. */}
      <div className="flex-1 max-w-xl" ref={searchRef}>
        <div className="relative">
          <span
            aria-hidden
            className={cn(
              'absolute left-2.5 top-1/2 -translate-y-1/2 text-sm font-bold transition-colors',
              searchQuery ? 'text-primary' : 'text-outline-variant'
            )}
          >
            ❯
          </span>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => { if (searchResults.length > 0) setShowResults(true); }}
            placeholder="search sessions, hooks, models…    (ctrl+k)"
            className="w-full h-8 pl-7 pr-9 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary focus:ring-0 transition-colors"
          />
          {isSearching ? (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-on-surface-variant animate-spin" />
          ) : (
            <Search className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-outline-variant" />
          )}

          {showResults && (
            <div className="absolute top-full mt-1 w-full max-h-96 overflow-y-auto bg-surface-container border border-outline-variant rounded-xs shadow-xl z-50">
              {searchResults.length === 0 && !isSearching ? (
                <div className="px-3 py-6 text-center text-[12px] text-on-surface-variant">
                  -- no matches --
                </div>
              ) : (
                Object.entries(groupedResults).map(([type, items]) => {
                  const meta = SEARCH_TYPE_META[type as SearchResult['type']];
                  if (!meta) return null;
                  const Icon = meta.icon;
                  return (
                    <div key={type}>
                      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-outline-variant px-3 py-1.5 border-b border-outline-variant/30 bg-surface-container-low">
                        <span>▸</span>
                        <span>{meta.label}</span>
                        <span className="ml-auto">{items.length}</span>
                      </div>
                      {items.map((result) => (
                        <button
                          key={result.id}
                          onClick={() => handleResultClick(result)}
                          className="w-full px-3 py-1.5 hover:bg-surface-container-high cursor-pointer transition-colors flex items-center gap-2.5 text-left border-l-2 border-transparent hover:border-primary"
                        >
                          <Icon className="w-3.5 h-3.5 text-on-surface-variant shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] text-on-surface truncate">{result.title}</p>
                            <p className="text-[11px] text-on-surface-variant truncate">{result.subtitle}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right side — workspace picker, notifications, profile. */}
      <div className="flex items-center gap-1.5">
        <WorkspacePicker />

        <div className="relative" ref={notifRef}>
          <button
            onClick={() => { setIsNotifOpen(!isNotifOpen); if (!isNotifOpen) fetchNotifications(); }}
            aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
            className="relative p-1.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-xs transition-colors cursor-pointer"
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[15px] h-3.5 bg-primary text-on-primary text-[9px] font-bold rounded-xs flex items-center justify-center px-1 leading-none">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {isNotifOpen && (
            <div className="absolute right-0 mt-1 w-80 bg-surface-container border border-outline-variant rounded-xs shadow-xl z-50 max-h-96 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant/60 bg-surface-container-low">
                <span className="text-[12px] text-on-surface flex items-center gap-1.5">
                  <span className="text-outline-variant">▸</span>
                  notifications
                </span>
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="text-[11px] text-primary hover:underline cursor-pointer"
                  >
                    mark all read
                  </button>
                )}
              </div>
              <div className="overflow-y-auto flex-1">
                {notifications.length === 0 ? (
                  <div className="px-3 py-8 text-center text-[12px] text-on-surface-variant">
                    -- no notifications --
                  </div>
                ) : (
                  notifications.slice(0, 20).map(notif => (
                    <button
                      key={notif.id}
                      onClick={() => { if (!notif.read) markRead(notif.id); }}
                      className={cn(
                        'w-full text-left px-3 py-2 border-b border-outline-variant/30 hover:bg-surface-container-high cursor-pointer transition-colors',
                        !notif.read && 'bg-primary-container/30'
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <span
                          aria-hidden
                          className={cn(
                            'mt-1.5 shrink-0 dot',
                            !notif.read ? 'dot-ok' : 'dot-idle'
                          )}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] text-on-surface truncate">{notif.title}</p>
                          {notif.body && (
                            <p className="text-[11px] text-on-surface-variant truncate mt-0.5">{notif.body}</p>
                          )}
                          <p className="text-[10px] text-outline mt-1" suppressHydrationWarning>
                            {new Date(notif.createdAt).toLocaleTimeString()}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="h-5 w-px bg-outline-variant/60 mx-1" />

        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setIsProfileOpen(!isProfileOpen)}
            className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant hover:text-on-surface rounded-xs hover:bg-surface-container cursor-pointer transition-colors"
          >
            <span
              aria-hidden
              className={cn('dot', user?.isAdmin ? 'dot-warn' : 'dot-ok')}
            />
            <div className="text-left hidden sm:block leading-tight">
              <p className="text-[12px] text-on-surface">{user?.username || 'guest'}</p>
              <p className="text-[10px] text-outline-variant uppercase tracking-wider">
                {user?.isAdmin ? 'root' : 'user'}
              </p>
            </div>
          </button>

          {isProfileOpen && (
            <div className="absolute right-0 mt-1 w-52 bg-surface-container border border-outline-variant rounded-xs shadow-xl py-1 z-50">
              {user ? (
                <>
                  <div className="px-3 py-2 border-b border-outline-variant/60 flex items-center gap-2">
                    <span
                      aria-hidden
                      className={cn('dot', user.isAdmin ? 'dot-warn' : 'dot-ok')}
                    />
                    <div className="min-w-0">
                      <p className="text-[13px] text-on-surface truncate">{user.username}</p>
                      <p className="text-[10px] text-on-surface-variant uppercase tracking-wider">
                        {user.isAdmin ? 'administrator' : 'user'}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => { router.push('/secrets'); setIsProfileOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer transition-colors"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                    secrets &amp; keys
                  </button>
                  <button
                    onClick={() => { router.push('/settings'); setIsProfileOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high cursor-pointer transition-colors"
                  >
                    <Settings className="w-3.5 h-3.5" />
                    settings
                  </button>
                  <div className="border-t border-outline-variant/60 mt-1 pt-1">
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-error hover:bg-error-container cursor-pointer transition-colors"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      sign out
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="px-3 py-2 border-b border-outline-variant/60">
                    <p className="text-[12px] text-on-surface-variant">not signed in</p>
                  </div>
                  <button
                    onClick={handleLogin}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-primary hover:bg-primary-container cursor-pointer transition-colors"
                  >
                    <User className="w-3.5 h-3.5" />
                    sign in
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

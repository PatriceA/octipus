'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bell, Search, User, LogOut, Settings, KeyRound, ChevronDown, MessageSquare, Webhook, Cpu, BookOpen, Brain, Wrench, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

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
  session: { label: 'Sessions', icon: MessageSquare },
  hook: { label: 'Hooks', icon: Webhook },
  model: { label: 'Models', icon: Cpu },
  skill: { label: 'Skills', icon: BookOpen },
  knowledge: { label: 'Knowledge', icon: Brain },
  tool: { label: 'Tools', icon: Wrench },
};

export function Header() {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [user, setUser] = useState<{ username: string; isAdmin: boolean } | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const { logout: authLogout } = useAuth();

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const storedUser = localStorage.getItem('assistant-user');
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {}
    }
  }, []);

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

  // Debounced search
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

  // Cmd+K / Ctrl+K to focus search
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

  // Group results by type
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
    <header className="h-16 bg-[#0e0e0e] px-6 shrink-0 flex items-center justify-between">
      {/* Search */}
      <div className="flex-1 max-w-md" ref={searchRef}>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => { if (searchResults.length > 0) setShowResults(true); }}
            placeholder="Search systems...  (Ctrl+K)"
            className="w-full pl-10 pr-4 py-1.5 bg-surface-container-low border border-outline-variant/10 rounded-full text-sm text-white placeholder-on-surface-variant focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
          />
          {isSearching && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant animate-spin" />
          )}

          {/* Search results dropdown */}
          {showResults && (
            <div className="absolute top-full mt-2 w-full max-h-96 overflow-y-auto bg-[#1a1a1a] rounded-2xl shadow-2xl ring-1 ring-outline-variant/20 z-50">
              {searchResults.length === 0 && !isSearching ? (
                <div className="px-4 py-8 text-center text-sm text-on-surface-variant">
                  No results found
                </div>
              ) : (
                Object.entries(groupedResults).map(([type, items]) => {
                  const meta = SEARCH_TYPE_META[type as SearchResult['type']];
                  if (!meta) return null;
                  const Icon = meta.icon;
                  return (
                    <div key={type}>
                      <div className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant px-3 py-2">
                        {meta.label}
                      </div>
                      {items.map((result) => (
                        <button
                          key={result.id}
                          onClick={() => handleResultClick(result)}
                          className="w-full px-3 py-2 hover:bg-[#20201f] cursor-pointer transition-colors flex items-center gap-3 text-left"
                        >
                          <Icon className="w-4 h-4 text-on-surface-variant shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm text-white truncate">{result.title}</p>
                            <p className="text-xs text-on-surface-variant truncate">{result.subtitle}</p>
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

      {/* Actions */}
      <div className="flex items-center gap-4">
        {/* Notification bell */}
        <div className="relative" ref={notifRef}>
          <button
            onClick={() => { setIsNotifOpen(!isNotifOpen); if (!isNotifOpen) fetchNotifications(); }}
            className="p-2 text-on-surface-variant hover:bg-[#1a1a1a] rounded-full transition-colors cursor-pointer relative"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute top-0.5 right-0.5 min-w-[16px] h-4 bg-primary text-on-primary text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>

          {isNotifOpen && (
            <div className="absolute right-0 mt-2 w-80 bg-[#1a1a1a] rounded-2xl shadow-2xl ring-1 ring-outline-variant/20 z-50 max-h-96 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-outline-variant/10">
                <span className="text-sm font-bold text-white">Notifications</span>
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="text-xs text-primary font-bold hover:underline cursor-pointer"
                  >
                    Mark all read
                  </button>
                )}
              </div>
              <div className="overflow-y-auto flex-1">
                {notifications.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-on-surface-variant">
                    No notifications
                  </div>
                ) : (
                  notifications.slice(0, 20).map(notif => (
                    <button
                      key={notif.id}
                      onClick={() => { if (!notif.read) markRead(notif.id); }}
                      className={`w-full text-left px-4 py-3 border-b border-outline-variant/5 hover:bg-surface-container-high cursor-pointer transition-colors ${
                        !notif.read ? 'bg-primary/5' : ''
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        {!notif.read && (
                          <span className="w-2 h-2 bg-primary rounded-full mt-1.5 shrink-0" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white truncate">{notif.title}</p>
                          {notif.body && (
                            <p className="text-xs text-on-surface-variant truncate mt-0.5">{notif.body}</p>
                          )}
                          <p className="text-[10px] text-on-surface-variant/60 mt-1" suppressHydrationWarning>
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

        {/* Divider */}
        <div className="h-6 w-px bg-outline-variant/20" />

        {/* Profile Dropdown */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setIsProfileOpen(!isProfileOpen)}
            className="flex items-center gap-3 p-1.5 text-on-surface-variant hover:text-white rounded-lg hover:bg-[#1a1a1a] cursor-pointer transition-colors"
          >
            <div className="text-right hidden sm:block">
              <p className="text-xs font-bold text-white leading-none">{user?.username || 'Guest'}</p>
              <p className="text-[10px] text-on-surface-variant">{user?.isAdmin ? 'Superuser Access' : 'User'}</p>
            </div>
            <div className="w-8 h-8 rounded-full bg-primary-container/20 flex items-center justify-center text-primary">
              <User className="w-4 h-4" />
            </div>
          </button>

          {isProfileOpen && (
            <div className="absolute right-0 mt-2 w-56 bg-[#1a1a1a] rounded-2xl shadow-2xl ring-1 ring-outline-variant/20 py-1 z-50">
              {user ? (
                <>
                  <div className="px-4 py-2.5 border-b border-outline-variant/10">
                    <p className="text-sm font-bold text-white">{user.username}</p>
                    <p className="text-xs text-on-surface-variant">{user.isAdmin ? 'Administrator' : 'User'}</p>
                  </div>
                  <div className="py-1">
                    <button
                      onClick={() => { router.push('/secrets'); setIsProfileOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-on-surface-variant hover:text-white hover:bg-surface-container-high cursor-pointer transition-colors"
                    >
                      <KeyRound className="w-4 h-4" />
                      Secrets & Keys
                    </button>
                    <button
                      onClick={() => { router.push('/settings'); setIsProfileOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-on-surface-variant hover:text-white hover:bg-surface-container-high cursor-pointer transition-colors"
                    >
                      <Settings className="w-4 h-4" />
                      Settings
                    </button>
                  </div>
                  <div className="border-t border-outline-variant/10 py-1">
                    <button
                      onClick={handleLogout}
                      className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-error hover:bg-error/10 cursor-pointer transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      Sign Out
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="px-4 py-2.5 border-b border-outline-variant/10">
                    <p className="text-sm text-on-surface-variant">Not signed in</p>
                  </div>
                  <button
                    onClick={handleLogin}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-primary hover:bg-primary/10 cursor-pointer transition-colors"
                  >
                    <User className="w-4 h-4" />
                    Sign In
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

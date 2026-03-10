'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Bell, Search, User, LogOut, Settings, KeyRound, ChevronDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { api, createWebSocket } from '@/lib/api';

interface Notification {
  id: string;
  type: string;
  title: string;
  body?: string;
  read: boolean;
  createdAt: string;
}

export function Header() {
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const [user, setUser] = useState<{ username: string; isAdmin: boolean } | null>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    const storedUser = localStorage.getItem('assistant-user');
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {
        // Ignore
      }
    }
  }, []);

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await api.get<{ notifications: Notification[] }>('/notifications');
      if (data?.notifications) {
        setNotifications(data.notifications);
        setUnreadCount(data.notifications.filter(n => !n.read).length);
      }
    } catch {
      // Ignore
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 30000);
    return () => clearInterval(interval);
  }, [fetchNotifications]);

  useEffect(() => {
    const token = api.getToken();
    if (!token) return;

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
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogin = () => {
    router.push('/login');
    setIsProfileOpen(false);
  };

  const handleLogout = () => {
    localStorage.removeItem('assistant-user');
    localStorage.removeItem('auth_token');
    setUser(null);
    setIsProfileOpen(false);
  };

  const markRead = async (id: string) => {
    try {
      await api.post(`/notifications/${id}/read`);
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch {
      // Ignore
    }
  };

  const markAllRead = async () => {
    try {
      await api.post('/notifications/read-all');
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch {
      // Ignore
    }
  };

  return (
    <header className="h-14 bg-white dark:bg-[#0E1726] border-b border-primary-100 dark:border-[#1E2D45] px-6 shrink-0">
      <div className="h-full flex items-center justify-between">
        {/* Search */}
        <div className="flex-1 max-w-md">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search..."
              className="w-full pl-10 pr-4 py-2 bg-primary-50/50 dark:bg-[#131C2E] border border-primary-200 dark:border-[#1E2D45] rounded-lg text-sm focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400 dark:text-gray-200 placeholder-gray-500 dark:placeholder-gray-500"
            />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {/* Notification bell */}
          <div className="relative" ref={notifRef}>
            <button
              onClick={() => { setIsNotifOpen(!isNotifOpen); if (!isNotifOpen) fetchNotifications(); }}
              className="p-2 text-gray-500 hover:text-primary-600 dark:text-gray-400 dark:hover:text-primary-400 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-950/30 relative cursor-pointer"
            >
              <Bell className="w-5 h-5" />
              {unreadCount > 0 && (
                <span className="absolute top-1 right-1 min-w-[16px] h-4 bg-primary-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>

            {isNotifOpen && (
              <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-[#131C2E] rounded-xl shadow-xl ring-1 ring-primary-200/60 dark:ring-[#1E2D45] z-50 max-h-96 flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700/60">
                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</span>
                  {unreadCount > 0 && (
                    <button
                      onClick={markAllRead}
                      className="text-xs text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300 font-medium cursor-pointer"
                    >
                      Mark all read
                    </button>
                  )}
                </div>
                <div className="overflow-y-auto flex-1">
                  {notifications.length === 0 ? (
                    <div className="px-4 py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                      No notifications
                    </div>
                  ) : (
                    notifications.slice(0, 20).map(notif => (
                      <button
                        key={notif.id}
                        onClick={() => { if (!notif.read) markRead(notif.id); }}
                        className={`w-full text-left px-4 py-3 border-b border-gray-50 dark:border-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/30 cursor-pointer ${
                          !notif.read ? 'bg-primary-50/50 dark:bg-primary-950/20' : ''
                        }`}
                      >
                        <div className="flex items-start gap-2.5">
                          {!notif.read && (
                            <span className="w-2 h-2 bg-primary-500 rounded-full mt-1.5 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                              {notif.title}
                            </p>
                            {notif.body && (
                              <p className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5">
                                {notif.body}
                              </p>
                            )}
                            <p className="text-[10px] text-gray-400 mt-1" suppressHydrationWarning>
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

          {/* Profile Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setIsProfileOpen(!isProfileOpen)}
              className="flex items-center gap-2 p-1.5 text-gray-600 hover:text-primary-700 dark:text-gray-400 dark:hover:text-primary-300 rounded-lg hover:bg-primary-50 dark:hover:bg-primary-950/30 cursor-pointer"
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center shadow-sm">
                <User className="w-4 h-4 text-white" />
              </div>
              <span className="text-sm font-medium hidden sm:block">{user?.username || 'Guest'}</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isProfileOpen ? 'rotate-180' : ''}`} />
            </button>

            {isProfileOpen && (
              <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-[#131C2E] rounded-xl shadow-xl ring-1 ring-primary-200/60 dark:ring-[#1E2D45] py-1 z-50">
                {user ? (
                  <>
                    <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/60">
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{user.username}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">{user.isAdmin ? 'Administrator' : 'User'}</p>
                    </div>
                    <div className="py-1">
                      <button
                        onClick={() => { router.push('/secrets'); setIsProfileOpen(false); }}
                        className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 cursor-pointer"
                      >
                        <KeyRound className="w-4 h-4" />
                        Secrets & Keys
                      </button>
                      <button
                        onClick={() => { router.push('/settings'); setIsProfileOpen(false); }}
                        className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50 cursor-pointer"
                      >
                        <Settings className="w-4 h-4" />
                        Settings
                      </button>
                    </div>
                    <div className="border-t border-gray-100 dark:border-gray-700/60 py-1">
                      <button
                        onClick={handleLogout}
                        className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        Sign Out
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/60">
                      <p className="text-sm text-gray-500 dark:text-gray-400">Not signed in</p>
                    </div>
                    <button
                      onClick={handleLogin}
                      className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-primary-700 dark:text-primary-400 hover:bg-primary-50 dark:hover:bg-primary-900/20"
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
      </div>
    </header>
  );
}

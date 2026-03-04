'use client';

import { useQuery } from '@tanstack/react-query';
import {
  KeyRound,
  ArrowRight,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { UserProfile, HealthStatus } from '@/lib/types/settings';

export function GeneralTab() {
  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get<UserProfile>('/auth/me'),
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: async () => {
      try {
        return await api.get<HealthStatus>('/health');
      } catch {
        return null;
      }
    },
  });

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">General Settings</h2>

      {/* Service Status */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Service Status</h3>
        <div className="grid grid-cols-2 gap-2">
          {health &&
            typeof health === 'object' &&
            'services' in health &&
            Object.entries((health as HealthStatus).services || {}).map(([name, svc]) => (
              <div
                key={name}
                className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
              >
                <span className="text-sm text-gray-700 dark:text-gray-300 capitalize">{name}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    svc.status === 'healthy'
                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                      : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                  }`}
                >
                  {svc.status}
                </span>
              </div>
            ))}
        </div>
      </div>

      {/* Profile */}
      <div>
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Profile</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Username</label>
            <input
              type="text"
              value={profile?.username || ''}
              readOnly
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl text-sm dark:text-gray-200"
            />
          </div>
          {profile?.email && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Email</label>
              <input
                type="text"
                value={profile.email}
                readOnly
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-800 ring-1 ring-gray-200/60 dark:ring-gray-700/60 rounded-xl text-sm dark:text-gray-200"
              />
            </div>
          )}
          <div>
            <label className="block text-xs text-gray-500 mb-1">Role</label>
            <span
              className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                profile?.isAdmin
                  ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300'
                  : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
              }`}
            >
              {profile?.isAdmin ? 'Admin' : 'User'}
            </span>
          </div>
        </div>
      </div>

      {/* Secrets redirect */}
      <Link
        href="/secrets"
        className="flex items-center justify-between p-4 bg-primary-50 dark:bg-primary-950/30 rounded-xl ring-1 ring-primary-200/60 dark:ring-primary-800/40 hover:bg-primary-100/80 dark:hover:bg-primary-950/50 transition-colors group"
      >
        <div className="flex items-center gap-3">
          <KeyRound className="w-5 h-5 text-primary-600 dark:text-primary-400" />
          <div>
            <p className="text-sm font-medium text-primary-900 dark:text-primary-300">Secrets & Credentials</p>
            <p className="text-xs text-primary-700/70 dark:text-primary-400/60">Manage API keys, OAuth credentials, and other secrets</p>
          </div>
        </div>
        <ArrowRight className="w-4 h-4 text-primary-400 group-hover:translate-x-0.5 transition-transform" />
      </Link>
    </div>
  );
}

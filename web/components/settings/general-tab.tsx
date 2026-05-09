'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  KeyRound,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import type { HealthStatus, UserProfile } from '@/lib/types/settings';

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
      <h2 className="text-lg font-extrabold tracking-tighter text-white">General Settings</h2>

      {/* Service Status */}
      <div>
        <h3 className="text-xs font-bold text-on-surface-variant uppercase mb-2">Service Status</h3>
        <div className="grid grid-cols-2 gap-2">
          {health &&
            typeof health === 'object' &&
            'services' in health &&
            Object.entries((health as HealthStatus).services || {}).map(([name, svc]) => (
              <div
                key={name}
                className="flex items-center justify-between p-2 bg-surface-container-low rounded-lg"
              >
                <span className="text-sm text-white capitalize">{name}</span>
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    svc.status === 'healthy'
                      ? 'bg-green-900/30 text-green-300'
                      : 'bg-red-900/30 text-red-300'
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
        <h3 className="text-xs font-bold text-on-surface-variant uppercase mb-2">Profile</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Username</label>
            <input
              type="text"
              value={profile?.username || ''}
              readOnly
              className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm"
            />
          </div>
          {profile?.email && (
            <div>
              <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Email</label>
              <input
                type="text"
                value={profile.email}
                readOnly
                className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm"
              />
            </div>
          )}
          <div>
            <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Role</label>
            <span
              className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                profile?.isAdmin
                  ? 'bg-purple-900/30 text-purple-300'
                  : 'bg-[#262626] text-on-surface-variant'
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
        className="flex items-center justify-between p-4 bg-primary/10 rounded-[1rem] hover:bg-primary/15 transition-colors group"
      >
        <div className="flex items-center gap-3">
          <KeyRound className="w-5 h-5 text-primary" />
          <div>
            <p className="text-sm font-medium text-primary">Secrets & Credentials</p>
            <p className="text-xs text-on-surface-variant">Manage API keys, OAuth credentials, and other secrets</p>
          </div>
        </div>
        <ArrowRight className="w-4 h-4 text-primary group-hover:translate-x-0.5 transition-transform" />
      </Link>
    </div>
  );
}

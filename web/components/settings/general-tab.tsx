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

  // `/health` is the liveness ping: `{ status, timestamp }` and nothing else.
  // The per-service breakdown this panel shows lives on `/health/detailed`.
  // Fetched once per visit, deliberately NOT polled: `/health/detailed` fans out
  // to a live probe of every configured provider, so an interval here would fire
  // that whole sweep for as long as the tab stays open.
  const { data: health } = useQuery({
    queryKey: ['health', 'detailed'],
    queryFn: async () => {
      try {
        return await api.get<HealthStatus>('/health/detailed');
      } catch {
        return null;
      }
    },
  });

  const services = Object.entries(health?.health ?? {});

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-extrabold tracking-tighter text-on-surface">General Settings</h2>

      {/* Service Status */}
      <section>
        <h3 className="text-xs font-bold text-on-surface-variant uppercase mb-2">Service Status</h3>
        {services.length === 0 ? (
          <p className="text-sm text-on-surface-variant border border-outline-variant rounded-md px-3 py-2">
            No health data — the backend did not answer /health/detailed.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {services.map(([name, svc]) => (
              <div
                key={name}
                className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-container-low border border-outline-variant rounded-md"
              >
                <span className="text-sm text-on-surface capitalize truncate">{name}</span>
                <span className="flex items-center gap-2 shrink-0">
                  {typeof svc.latency === 'number' && (
                    <span className="text-xs text-on-surface-variant tabular-nums">{svc.latency}ms</span>
                  )}
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      svc.status === 'healthy'
                        ? 'bg-tertiary-container/60 text-tertiary'
                        : 'bg-error-container/60 text-error'
                    }`}
                  >
                    {svc.status}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

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
              className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm"
            />
          </div>
          {profile?.email && (
            <div>
              <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Email</label>
              <input
                type="text"
                value={profile.email}
                readOnly
                className="w-full bg-surface-container-high border border-outline-variant rounded-md py-3 px-4 text-on-surface text-sm"
              />
            </div>
          )}
          <div>
            <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Role</label>
            <span
              className={`inline-block px-2 py-0.5 text-xs rounded-full ${
                profile?.isAdmin
                  ? 'bg-purple-900/30 text-primary'
                  : 'bg-surface-container-high text-on-surface-variant'
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
        className="flex items-center justify-between p-4 bg-primary/10 rounded-xs hover:bg-primary/15 transition-colors group"
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

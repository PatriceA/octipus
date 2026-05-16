'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  isAdmin: boolean;
  isActive: boolean;
  totpEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { user: currentUser } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createIsAdmin, setCreateIsAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<{ users: AdminUser[] }>('/admin/users'),
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<AdminUser>('/admin/users', body),
    onSuccess: () => {
      setShowCreate(false);
      setCreateName(''); setCreateEmail(''); setCreatePassword(''); setCreateIsAdmin(false);
      queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch<AdminUser>(`/admin/users/${id}`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
    onError: (err: Error) => setError(err.message),
  });

  const handleCreate = () => {
    if (!createName.trim()) return;
    createMutation.mutate({
      username: createName.trim(),
      email: createEmail.trim() || undefined,
      password: createPassword || undefined,
      isAdmin: createIsAdmin,
    });
  };

  const users = data?.users ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-extrabold tracking-tighter text-on-surface">Users</h2>
        <button
          type="button"
          onClick={() => { setShowCreate(true); setError(null); }}
          className="px-3 py-2 bg-primary text-[#0e0e0e] rounded-lg text-sm font-medium hover:bg-primary-container flex items-center gap-2 cursor-pointer"
        >
          <UserPlus className="w-4 h-4" /> New user
        </button>
      </div>

      {showCreate && (
        <div className="p-4 bg-surface-container rounded-lg space-y-3 border border-primary/20">
          <h3 className="font-medium text-on-surface text-sm">Create user</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value.slice(0, 64))}
              placeholder="Username"
              className="bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
            />
            <input
              type="email"
              value={createEmail}
              onChange={(e) => setCreateEmail(e.target.value)}
              placeholder="Email (optional)"
              className="bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
            />
            <input
              type="password"
              value={createPassword}
              onChange={(e) => setCreatePassword(e.target.value)}
              placeholder="Initial password (≥8 chars, optional)"
              className="md:col-span-2 bg-surface-container-high border-none rounded-md py-2 px-3 text-on-surface text-sm focus:ring-1 focus:ring-primary"
            />
            <label className="flex items-center gap-2 text-sm text-on-surface">
              <input
                type="checkbox"
                checked={createIsAdmin}
                onChange={(e) => setCreateIsAdmin(e.target.checked)}
              />
              Grant admin
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCreate}
              disabled={!createName.trim() || createMutation.isPending}
              className="px-3 py-2 bg-primary text-[#0e0e0e] rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer"
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-3 py-2 bg-surface-container-high text-on-surface-variant rounded-lg text-sm hover:text-on-surface cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="p-2 bg-error-dim/10 border border-error-dim/20 rounded text-sm text-error">{error}</div>
      )}

      <div className="overflow-hidden bg-surface-container rounded-lg">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-on-surface-variant">
            <tr className="border-b border-outline-variant/10">
              <th className="text-left px-4 py-2 font-medium">Username</th>
              <th className="text-left px-4 py-2 font-medium">Email</th>
              <th className="text-left px-4 py-2 font-medium">Role</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Last login</th>
              <th className="text-right px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td colSpan={6} className="px-4 py-3 text-on-surface-variant">Loading…</td></tr>
            )}
            {!isLoading && users.map((u) => {
              const isSelf = u.id === currentUser?.id;
              return (
                <tr key={u.id} className="border-b border-outline-variant/5 last:border-0">
                  <td className="px-4 py-3 text-on-surface font-medium flex items-center gap-2">
                    {u.username}
                    {u.isAdmin && <ShieldCheck className="w-4 h-4 text-primary" aria-label="admin" />}
                  </td>
                  <td className="px-4 py-3 text-on-surface-variant">{u.email ?? '—'}</td>
                  <td className="px-4 py-3 text-on-surface-variant">{u.isAdmin ? 'Admin' : 'User'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 text-xs rounded-full ${
                      u.isActive
                        ? 'bg-green-900/30 text-green-300'
                        : 'bg-surface-container-high text-on-surface-variant'
                    }`}>
                      {u.isActive ? 'Active' : 'Disabled'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-on-surface-variant">{formatRelative(u.lastLoginAt)}</td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      type="button"
                      disabled={isSelf || patchMutation.isPending}
                      onClick={() => patchMutation.mutate({ id: u.id, body: { isActive: !u.isActive } })}
                      className="px-2 py-1 text-xs bg-surface-container-high rounded hover:bg-[#333] text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      title={isSelf ? 'You cannot disable yourself' : (u.isActive ? 'Disable user' : 'Re-enable user')}
                    >
                      {u.isActive ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      disabled={isSelf || patchMutation.isPending}
                      onClick={() => patchMutation.mutate({ id: u.id, body: { isAdmin: !u.isAdmin } })}
                      className="px-2 py-1 text-xs bg-surface-container-high rounded hover:bg-[#333] text-on-surface-variant hover:text-on-surface disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      title={isSelf ? 'You cannot demote yourself' : (u.isAdmin ? 'Revoke admin' : 'Grant admin')}
                    >
                      {u.isAdmin ? 'Revoke admin' : 'Grant admin'}
                    </button>
                    <button
                      type="button"
                      disabled={isSelf || !u.isActive}
                      onClick={() => {
                        const reason = window.prompt(
                          `Act as "${u.username}"? This is fully audited under both your account and theirs. Optional reason:`,
                          '',
                        );
                        if (reason === null) return; // cancelled
                        api.post(`/admin/impersonate/${u.id}`, { reason })
                          .then(() => { window.location.href = '/'; })
                          .catch((err: Error) => alert(err.message));
                      }}
                      className="px-2 py-1 text-xs bg-yellow-700/40 rounded hover:bg-yellow-700/60 text-yellow-200 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                      title={isSelf ? 'You cannot impersonate yourself' : !u.isActive ? 'Cannot impersonate a disabled user' : 'Start impersonation (audited)'}
                    >
                      Act as
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

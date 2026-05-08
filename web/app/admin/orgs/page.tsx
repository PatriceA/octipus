'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ChevronRight, Plus, ShieldCheck, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';

interface AdminOrg {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
}

interface OrgMember {
  userId: string;
  username: string;
  role: string;
  joinedAt: string;
}

export default function AdminOrgsPage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [createSlug, setCreateSlug] = useState('');
  const [createName, setCreateName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['admin', 'orgs'],
    queryFn: () => api.get<{ orgs: AdminOrg[] }>('/admin/orgs'),
  });

  const flagDisabled = (queryError as Error | null)?.message?.includes('404');

  const createMutation = useMutation({
    mutationFn: (body: { slug: string; name: string }) => api.post<AdminOrg>('/admin/orgs', body),
    onSuccess: () => {
      setShowCreate(false);
      setCreateSlug('');
      setCreateName('');
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['admin', 'orgs'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleCreate = () => {
    if (!createSlug.trim() || !createName.trim()) return;
    createMutation.mutate({ slug: createSlug.trim(), name: createName.trim() });
  };

  if (flagDisabled) {
    return (
      <div className="p-8 text-center text-on-surface-variant">
        Multi-user orgs are disabled. Enable <code className="text-white">multiuser.orgWorkspaces</code> in settings to manage organizations.
      </div>
    );
  }

  const orgs = data?.orgs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-extrabold tracking-tighter text-white">Organizations</h2>
        <button
          type="button"
          onClick={() => { setShowCreate(true); setError(null); }}
          className="px-3 py-2 bg-primary text-[#0e0e0e] rounded-lg text-sm font-medium hover:bg-primary-container flex items-center gap-2 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          New org
        </button>
      </div>

      {showCreate && (
        <div className="bg-surface-container-low border border-outline-variant/10 rounded-2xl p-4 space-y-3">
          <div className="text-sm font-bold text-white">New organization</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Slug</label>
              <input
                type="text"
                value={createSlug}
                onChange={(e) => setCreateSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="acme"
                className="mt-1 w-full px-3 py-1.5 bg-[#0e0e0e] border border-outline-variant/20 rounded-lg text-sm text-white"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">Name</label>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="Acme Inc."
                className="mt-1 w-full px-3 py-1.5 bg-[#0e0e0e] border border-outline-variant/20 rounded-lg text-sm text-white"
              />
            </div>
          </div>
          {error && <p className="text-xs text-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => { setShowCreate(false); setError(null); }}
              className="px-3 py-1.5 text-sm text-on-surface-variant hover:text-white cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={createMutation.isPending || !createSlug || !createName}
              className="px-3 py-1.5 text-sm bg-primary text-[#0e0e0e] font-bold rounded-lg disabled:opacity-50 cursor-pointer"
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="p-8 text-center text-on-surface-variant">Loading…</div>
      ) : orgs.length === 0 ? (
        <div className="p-8 text-center text-on-surface-variant border border-outline-variant/10 rounded-2xl border-dashed">
          No organizations yet.
        </div>
      ) : (
        <div className="space-y-2">
          {orgs.map((o) => (
            <OrgRow
              key={o.id}
              org={o}
              expanded={expandedId === o.id}
              onToggle={() => setExpandedId(expandedId === o.id ? null : o.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OrgRow({ org, expanded, onToggle }: { org: AdminOrg; expanded: boolean; onToggle: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'orgs', org.id, 'members'],
    queryFn: () => api.get<{ members: OrgMember[] }>(`/admin/orgs/${org.id}/members`),
    enabled: expanded,
  });

  return (
    <div className="bg-surface-container-low border border-outline-variant/10 rounded-2xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#1a1a1a] cursor-pointer transition-colors text-left"
      >
        <Building2 className="w-4 h-4 text-on-surface-variant" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{org.name}</p>
          <p className="text-xs text-on-surface-variant">/{org.slug}</p>
        </div>
        <ChevronRight className={`w-4 h-4 text-on-surface-variant transition-transform ${expanded ? 'rotate-90' : ''}`} />
      </button>
      {expanded && (
        <div className="border-t border-outline-variant/10 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold text-on-surface-variant">
              <Users className="w-3 h-3" />
              Members
            </div>
            <Link
              href={`/admin/orgs/${org.id}/sso`}
              className="flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              SSO + SCIM
            </Link>
          </div>
          {isLoading ? (
            <p className="text-sm text-on-surface-variant">Loading…</p>
          ) : (data?.members ?? []).length === 0 ? (
            <p className="text-sm text-on-surface-variant">No members.</p>
          ) : (
            <ul className="space-y-1">
              {(data?.members ?? []).map((m) => (
                <li key={m.userId} className="flex items-center justify-between text-sm">
                  <span className="text-white">{m.username}</span>
                  <span className="text-xs text-on-surface-variant">{m.role}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

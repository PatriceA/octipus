'use client';

import { Plus, RotateCcw, Search, Trash2, } from 'lucide-react';
import { useState, } from 'react';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import {
  CREDENTIAL_TYPE_COLORS,
  type Credential,
  type CredentialType,
} from '@/lib/vault-config';

interface VaultTableProps {
  credentials: Credential[];
  onRefresh: () => void;
  workspaceId?: string | null;
  workspaceName?: string | null;
}

export function VaultTable({ credentials, onRefresh, workspaceId, workspaceName }: VaultTableProps) {
  const [search, setSearch] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const filtered = credentials.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.credentialType.toLowerCase().includes(q) ||
      c.description?.toLowerCase().includes(q) ||
      c.tags?.some((t) => t.toLowerCase().includes(q))
    );
  });

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/vault/${id}`);
      onRefresh();
      setDeleteId(null);
    } catch (error) {
      console.error('Failed to delete credential:', error);
    }
  };

  const handleRotate = async (id: string, newValue: string) => {
    try {
      await api.post(`/vault/${id}/rotate`, { value: newValue });
      setRotateId(null);
      onRefresh();
    } catch (error) {
      console.error('Failed to rotate credential:', error);
    }
  };

  const handleAdd = async (data: {
    name: string;
    value: string;
    credentialType: CredentialType;
    description?: string;
    tags?: string[];
    scope: 'user' | 'workspace';
  }) => {
    try {
      const payload: Record<string, unknown> = { ...data };
      if (data.scope === 'workspace' && workspaceId) {
        payload.workspaceId = workspaceId;
      }
      await api.post('/vault', payload);
      setShowAddModal(false);
      onRefresh();
    } catch (error) {
      console.error('Failed to add credential:', error);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-extrabold tracking-tighter text-white">
          All Vault Entries
        </h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-[#0e0e0e] rounded-lg hover:bg-primary-container cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Secret
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-on-surface-variant" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name, type, or tag..."
          className="w-full pl-10 pr-4 py-2 text-sm bg-[#262626] border-none rounded-md text-white placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-10 text-sm text-on-surface-variant">
          {credentials.length === 0
            ? 'No secrets stored yet.'
            : 'No secrets match your filter.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xs bg-[#1a1a1a]">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-outline-variant/10">
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Name</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Type</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Tags</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Access</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider">Last Used</th>
                <th className="py-2.5 px-4 text-xs font-bold text-on-surface-variant uppercase tracking-wider w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/10">
              {filtered.map((cred) => {
                const colors = CREDENTIAL_TYPE_COLORS[cred.credentialType] || CREDENTIAL_TYPE_COLORS.other;
                return (
                  <tr
                    key={cred.id}
                    className="hover:bg-[#20201f] transition-colors"
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-sm text-white">{cred.name}</div>
                      {cred.description && (
                        <div className="text-xs text-on-surface-variant mt-0.5">{cred.description}</div>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${colors.bg} ${colors.text}`}>
                        {cred.credentialType.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex flex-wrap gap-1">
                        {cred.tags?.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex px-1.5 py-0.5 text-[10px] rounded bg-[#262626] text-on-surface-variant"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-sm text-on-surface-variant tabular-nums">
                      {cred.accessCount}
                    </td>
                    <td className="py-2.5 px-4 text-sm text-on-surface-variant">
                      {cred.lastAccessedAt
                        ? new Date(cred.lastAccessedAt).toLocaleDateString()
                        : 'Never'}
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setRotateId(cred.id)}
                          className="p-1.5 text-on-surface-variant hover:text-primary rounded-md hover:bg-[#20201f] cursor-pointer"
                          title="Rotate"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteId(cred.id)}
                          className="p-1.5 text-on-surface-variant hover:text-error rounded-md hover:bg-[#20201f] cursor-pointer"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Modal */}
      <Modal open={showAddModal} onClose={() => setShowAddModal(false)} title="Add Secret" maxWidth="md">
        <AddSecretForm
          onCancel={() => setShowAddModal(false)}
          onAdd={handleAdd}
          workspaceName={workspaceName ?? null}
          workspaceAvailable={!!workspaceId}
        />
      </Modal>

      {/* Rotate Modal */}
      <Modal open={!!rotateId} onClose={() => setRotateId(null)} title="Rotate Secret" maxWidth="sm">
        <RotateForm
          onCancel={() => setRotateId(null)}
          onRotate={(value) => rotateId && handleRotate(rotateId, value)}
        />
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={!!deleteId} onClose={() => setDeleteId(null)} title="Delete Secret" maxWidth="sm">
        <div className="space-y-4">
          <p className="text-sm text-on-surface-variant">
            This will deactivate the credential. This action cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteId(null)}
              className="px-4 py-2 text-sm text-on-surface-variant hover:bg-[#1a1a1a] rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => deleteId && handleDelete(deleteId)}
              className="px-4 py-2 text-sm bg-error text-white rounded-lg hover:bg-error-dim cursor-pointer"
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function AddSecretForm({
  onCancel,
  onAdd,
  workspaceName,
  workspaceAvailable,
}: {
  onCancel: () => void;
  onAdd: (data: { name: string; value: string; credentialType: CredentialType; description?: string; tags?: string[]; scope: 'user' | 'workspace' }) => void;
  workspaceName: string | null;
  workspaceAvailable: boolean;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [credentialType, setCredentialType] = useState<CredentialType>('api_key');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [scope, setScope] = useState<'user' | 'workspace'>('user');

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
          placeholder="my_api_key"
        />
      </div>
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Value</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
        />
      </div>
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Type</label>
        <select
          value={credentialType}
          onChange={(e) => setCredentialType(e.target.value as CredentialType)}
          className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
        >
          <option value="api_key">API Key</option>
          <option value="oauth_token">OAuth Token</option>
          <option value="password">Password</option>
          <option value="ssh_key">SSH Key</option>
          <option value="certificate">Certificate</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
          placeholder="Optional description"
        />
      </div>
      {workspaceAvailable && (
        <div>
          <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Scope</label>
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'user' | 'workspace')}
            className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
          >
            <option value="user">User (visible everywhere)</option>
            <option value="workspace">Workspace ({workspaceName ?? 'current'})</option>
          </select>
        </div>
      )}
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">Tags (comma-separated)</label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm placeholder-on-surface-variant focus:ring-1 focus:ring-primary"
          placeholder="production, openai"
        />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-on-surface-variant hover:bg-[#1a1a1a] rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() =>
            onAdd({
              name,
              value,
              credentialType,
              description: description || undefined,
              tags: tags ? tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
              scope,
            })
          }
          disabled={!name || !value}
          className="px-4 py-2 text-sm bg-primary text-[#0e0e0e] rounded-lg hover:bg-primary-container disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function RotateForm({
  onCancel,
  onRotate,
}: {
  onCancel: () => void;
  onRotate: (value: string) => void;
}) {
  const [value, setValue] = useState('');

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-bold text-on-surface-variant uppercase mb-2 block">New Value</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full bg-[#262626] border-none rounded-md py-3 px-4 text-white text-sm focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-on-surface-variant hover:bg-[#1a1a1a] rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() => onRotate(value)}
          disabled={!value}
          className="px-4 py-2 text-sm bg-primary text-[#0e0e0e] rounded-lg hover:bg-primary-container disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Rotate
        </button>
      </div>
    </div>
  );
}

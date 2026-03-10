'use client';

import { useState, useEffect } from 'react';
import { Search, RotateCcw, Trash2, Plus, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import {
  type Credential,
  type CredentialType,
  CREDENTIAL_TYPE_COLORS,
} from '@/lib/vault-config';

interface VaultTableProps {
  credentials: Credential[];
  onRefresh: () => void;
}

export function VaultTable({ credentials, onRefresh }: VaultTableProps) {
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
  }) => {
    try {
      await api.post('/vault', data);
      setShowAddModal(false);
      onRefresh();
    } catch (error) {
      console.error('Failed to add credential:', error);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          All Vault Entries
        </h2>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary-800 text-white rounded-lg hover:bg-primary-900 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Secret
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter by name, type, or tag..."
          className="w-full pl-10 pr-4 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-200 placeholder-gray-500 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500/40 focus:border-primary-400"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-10 text-sm text-gray-500 dark:text-gray-400">
          {credentials.length === 0
            ? 'No secrets stored yet.'
            : 'No secrets match your filter.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg ring-1 ring-gray-200/60 dark:ring-gray-700/60">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
                <th className="py-2.5 px-4 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Name</th>
                <th className="py-2.5 px-4 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Type</th>
                <th className="py-2.5 px-4 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Tags</th>
                <th className="py-2.5 px-4 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Access</th>
                <th className="py-2.5 px-4 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Last Used</th>
                <th className="py-2.5 px-4 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {filtered.map((cred) => {
                const colors = CREDENTIAL_TYPE_COLORS[cred.credentialType] || CREDENTIAL_TYPE_COLORS.other;
                return (
                  <tr
                    key={cred.id}
                    className="hover:bg-primary-50/30 dark:hover:bg-primary-950/10 transition-colors"
                  >
                    <td className="py-2.5 px-4">
                      <div className="font-medium text-sm text-gray-900 dark:text-gray-100">{cred.name}</div>
                      {cred.description && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{cred.description}</div>
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
                            className="inline-flex px-1.5 py-0.5 text-[10px] rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-2.5 px-4 text-sm text-gray-600 dark:text-gray-400 tabular-nums">
                      {cred.accessCount}
                    </td>
                    <td className="py-2.5 px-4 text-sm text-gray-600 dark:text-gray-400">
                      {cred.lastAccessedAt
                        ? new Date(cred.lastAccessedAt).toLocaleDateString()
                        : 'Never'}
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setRotateId(cred.id)}
                          className="p-1.5 text-gray-500 hover:text-primary-600 dark:text-gray-400 dark:hover:text-primary-400 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700/50 cursor-pointer"
                          title="Rotate"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteId(cred.id)}
                          className="p-1.5 text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700/50 cursor-pointer"
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
          <p className="text-sm text-gray-600 dark:text-gray-400">
            This will deactivate the credential. This action cannot be undone.
          </p>
          <div className="flex justify-end gap-3">
            <button
              onClick={() => setDeleteId(null)}
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={() => deleteId && handleDelete(deleteId)}
              className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 cursor-pointer"
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
}: {
  onCancel: () => void;
  onAdd: (data: { name: string; value: string; credentialType: CredentialType; description?: string; tags?: string[] }) => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [credentialType, setCredentialType] = useState<CredentialType>('api_key');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-200 placeholder-gray-500 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500/40"
          placeholder="my_api_key"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Value</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-200 focus:ring-2 focus:ring-primary-500/40"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
        <select
          value={credentialType}
          onChange={(e) => setCredentialType(e.target.value as CredentialType)}
          className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-200 focus:ring-2 focus:ring-primary-500/40"
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
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-200 placeholder-gray-500 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500/40"
          placeholder="Optional description"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tags (comma-separated)</label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-200 placeholder-gray-500 dark:placeholder-gray-500 focus:ring-2 focus:ring-primary-500/40"
          placeholder="production, openai"
        />
      </div>
      <div className="flex justify-end gap-3 pt-2">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
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
            })
          }
          disabled={!name || !value}
          className="px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
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
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New Value</label>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-900 dark:text-gray-200 focus:ring-2 focus:ring-primary-500/40"
        />
      </div>
      <div className="flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={() => onRotate(value)}
          disabled={!value}
          className="px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          Rotate
        </button>
      </div>
    </div>
  );
}

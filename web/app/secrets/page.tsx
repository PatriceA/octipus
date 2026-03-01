'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Key, Plus, RotateCcw, Trash2 } from 'lucide-react';

interface Credential {
  id: string;
  name: string;
  credentialType: string;
  description?: string;
  tags: string[];
  accessCount: string;
  allowedSkills: string[];
  allowedAgents: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  expiresAt?: string;
}

type CredentialType = 'api_key' | 'oauth_token' | 'password' | 'ssh_key' | 'certificate' | 'other';

export default function SecretsPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [rotateId, setRotateId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const fetchCredentials = async () => {
    try {
      const data = await api.get<{ credentials?: Credential[] }>('/vault');
      setCredentials(data?.credentials ?? []);
    } catch (error) {
      console.error('Failed to fetch credentials:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCredentials();
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/vault/${id}`);
      setCredentials((prev) => prev.filter((c) => c.id !== id));
      setDeleteId(null);
    } catch (error) {
      console.error('Failed to delete credential:', error);
    }
  };

  const handleRotate = async (id: string, newValue: string) => {
    try {
      await api.post(`/vault/${id}/rotate`, { value: newValue });
      setRotateId(null);
      fetchCredentials();
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
      fetchCredentials();
    } catch (error) {
      console.error('Failed to add credential:', error);
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-48" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Key className="w-6 h-6 text-gray-700 dark:text-gray-300" />
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Secrets</h1>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Secret
        </button>
      </div>

      {credentials.length === 0 ? (
        <div className="text-center py-12 text-gray-500 dark:text-gray-400">
          No secrets stored yet. Click "Add Secret" to create one.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th className="py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">Name</th>
                <th className="py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">Type</th>
                <th className="py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">Tags</th>
                <th className="py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">Access Count</th>
                <th className="py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">Last Accessed</th>
                <th className="py-3 px-4 text-sm font-medium text-gray-500 dark:text-gray-400">Actions</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((cred) => (
                <tr
                  key={cred.id}
                  className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <td className="py-3 px-4">
                    <div className="font-medium text-gray-900 dark:text-white">{cred.name}</div>
                    {cred.description && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">{cred.description}</div>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <span className="inline-flex px-2 py-1 text-xs font-medium rounded-full bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                      {cred.credentialType}
                    </span>
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex flex-wrap gap-1">
                      {cred.tags?.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex px-2 py-0.5 text-xs rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                    {cred.accessCount}
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                    {cred.lastAccessedAt
                      ? new Date(cred.lastAccessedAt).toLocaleDateString()
                      : 'Never'}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRotateId(cred.id)}
                        className="p-1.5 text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                        title="Rotate"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setDeleteId(cred.id)}
                        className="p-1.5 text-gray-500 hover:text-red-600 dark:hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Modal */}
      {showAddModal && (
        <AddSecretModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAdd}
        />
      )}

      {/* Rotate Modal */}
      {rotateId && (
        <RotateModal
          onClose={() => setRotateId(null)}
          onRotate={(value) => handleRotate(rotateId, value)}
        />
      )}

      {/* Delete Confirmation */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Delete Secret?</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              This will deactivate the credential. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddSecretModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (data: { name: string; value: string; credentialType: CredentialType; description?: string; tags?: string[] }) => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [credentialType, setCredentialType] = useState<CredentialType>('api_key');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Add Secret</h3>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              placeholder="my_api_key"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Value</label>
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
            <select
              value={credentialType}
              onChange={(e) => setCredentialType(e.target.value as CredentialType)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
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
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              placeholder="Optional description"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tags (comma-separated)</label>
            <input
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
              placeholder="production, openai"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button
            onClick={onClose}
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
            className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function RotateModal({
  onClose,
  onRotate,
}: {
  onClose: () => void;
  onRotate: (value: string) => void;
}) {
  const [value, setValue] = useState('');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Rotate Secret</h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New Value</label>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
          >
            Cancel
          </button>
          <button
            onClick={() => onRotate(value)}
            disabled={!value}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Rotate
          </button>
        </div>
      </div>
    </div>
  );
}

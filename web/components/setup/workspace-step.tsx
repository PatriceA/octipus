'use client';

import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

const inputClasses =
  'w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm focus:ring-2 focus:ring-primary-500';

export interface WorkspaceStepProps {
  workspacePath: string;
  setWorkspacePath: (v: string) => void;
  saving: boolean;
  setSaving: (v: boolean) => void;
  setError: (v: string) => void;
}

export function WorkspaceStep({
  workspacePath,
  setWorkspacePath,
  saving,
  setSaving,
  setError,
}: WorkspaceStepProps) {
  const saveWorkspaceSettings = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/settings/${encodeURIComponent('workspace.rootPath')}`, { value: workspacePath });
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Workspace</h2>
      <p className="text-sm text-gray-500">Set the root directory the agent can access.</p>

      <div>
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Workspace Root Path</label>
        <input
          type="text"
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          placeholder="./workspace"
          className={`${inputClasses} font-mono`}
        />
      </div>

      <button
        onClick={saveWorkspaceSettings}
        disabled={saving}
        className="px-4 py-2 text-sm bg-primary-800 text-white rounded-lg hover:bg-primary-900 disabled:opacity-50"
      >
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
      </button>
    </div>
  );
}

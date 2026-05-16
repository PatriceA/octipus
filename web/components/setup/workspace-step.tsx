'use client';

import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

const inputClass =
  'w-full px-3 py-2 bg-surface-container-low border border-outline-variant/60 rounded-xs text-[13px] text-on-surface placeholder-outline-variant focus:outline-none focus:border-primary transition-colors';
const labelClass = 'block text-[10px] uppercase tracking-wider text-outline-variant mb-1';

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
      <div>
        <h2 className="text-[14px] text-on-surface flex items-center gap-2">
          <span className="text-primary" aria-hidden>❯</span>
          workspace
        </h2>
        <p className="text-[12px] text-on-surface-variant mt-1">
          root directory the agent can access on this host.
        </p>
      </div>

      <div>
        <label className={labelClass}>workspace root path</label>
        <input
          type="text"
          value={workspacePath}
          onChange={(e) => setWorkspacePath(e.target.value)}
          placeholder="./workspace"
          className={inputClass}
        />
      </div>

      <button
        onClick={saveWorkspaceSettings}
        disabled={saving}
        className="px-3 py-1.5 text-[12px] bg-primary text-on-primary rounded-xs hover:bg-primary-dim disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '❯ save'}
      </button>
    </div>
  );
}

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Code2, Download, Loader2, Unplug } from 'lucide-react';
import { useState } from 'react';
import type { CocoIndexStatus } from '../../../src/shared/cocoindex';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { CocoIndexWindowsSetup } from './cocoindex-windows-setup';

const endpoint = '/connectors/cocoindex';
const busyStates = new Set(['installing', 'configuring', 'connecting']);
const statusLabels: Record<CocoIndexStatus['status'], string> = {
  not_installed: 'Not installed', installing: 'Installing', configuring: 'Setting up',
  connecting: 'Connecting', connected: 'Connected', disconnected: 'Disconnected', error: 'Setup needs attention',
};

export function CocoIndexCard() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [embeddingModel, setEmbeddingModel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const { data, error, isLoading } = useQuery({
    queryKey: ['cocoindex-connector'],
    queryFn: () => api.get<CocoIndexStatus>(endpoint),
    enabled: !!user?.isAdmin,
    refetchInterval: query => busyStates.has(query.state.data?.status ?? '') ? 1500 : 15_000,
  });
  const busy = submitting || busyStates.has(data?.status ?? '');
  const folder = workspacePath ?? data?.workspacePath ?? '';
  const model = embeddingModel ?? data?.embedding.model ?? '';
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['cocoindex-connector'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-servers'] }),
    ]);
  };
  const install = async () => {
    setSubmitting(true);
    setActionError('');
    try {
      const status = await api.post<CocoIndexStatus>(`${endpoint}/install`, {
        workspacePath: folder.trim(), embeddingModel: model.trim(),
      });
      queryClient.setQueryData(['cocoindex-connector'], status);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };
  const remove = async () => {
    setSubmitting(true);
    setActionError('');
    try {
      await api.delete(endpoint);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="cocoindex-title" className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 p-4 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-lg bg-surface-container-low flex items-center justify-center shrink-0 text-primary">
          <Code2 aria-hidden="true" className="w-6 h-6" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 id="cocoindex-title" className="font-medium text-on-surface">CocoIndex Code</h3>
            <span className="text-[10px] rounded-full px-2 py-0.5 bg-surface-container-low text-on-surface-variant">Optional · Local</span>
            {data && <span role="status" className="text-xs text-primary">{statusLabels[data.status]}</span>}
          </div>
          <p className="text-xs text-on-surface-variant mt-1">Find code by meaning through a separate code index. Octipus’s knowledge base stays unchanged.</p>
          <a href="https://github.com/cocoindex-io/cocoindex-code" target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline underline-offset-2">About CocoIndex Code</a>
        </div>
      </div>

      <CocoIndexWindowsSetup />

      {!user?.isAdmin ? (
        <p className="text-sm text-on-surface-variant">Ask an administrator to install and configure this connector.</p>
      ) : isLoading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-on-surface-variant"><Loader2 className="w-4 h-4 animate-spin" />Checking installation…</p>
      ) : error ? (
        <div role="alert" className="text-sm text-error">
          Could not check CocoIndex: {error.message}
          <button type="button" onClick={() => void refresh()} className="ml-2 underline cursor-pointer">Retry status</button>
        </div>
      ) : data ? (
        <form onSubmit={event => { event.preventDefault(); void install(); }} className="space-y-3">
          <p className="text-xs text-on-surface-variant">Runs on the Octipus backend machine and is shared with agents on this server. Choose a folder within its configured workspace paths.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-on-surface-variant">
              Folder on the backend
              <input required disabled={busy} value={folder} onChange={event => setWorkspacePath(event.target.value)} placeholder="/path/to/repositories" className="mt-1 block w-full rounded-lg border border-outline-variant/30 bg-surface-container-low p-2 text-sm text-on-surface disabled:opacity-60" />
            </label>
            <label className="block text-xs text-on-surface-variant">
              Local embedding model
              <input required disabled={busy} value={model} onChange={event => setEmbeddingModel(event.target.value)} className="mt-1 block w-full rounded-lg border border-outline-variant/30 bg-surface-container-low p-2 text-sm text-on-surface disabled:opacity-60" />
            </label>
          </div>
          <p className="text-xs text-on-surface-variant">Managed setup supports Linux and macOS backends. Requires Python 3.11+ and uv or pipx, or an existing CocoIndex installation with local embedding support. Dependencies can use several GB of disk space. Setup downloads the model and builds the initial index, which may take time. Code is embedded locally without an API key.</p>
          {data.configured && <p className="text-xs text-on-surface-variant">Removing the connector disconnects it from Octipus. The installed package and index files remain on disk.</p>}
          {data.progress && <p role="status" className="text-sm text-primary break-words">{data.progress.message}</p>}
          {(actionError || data.error) && <p role="alert" className="text-sm text-error break-words">{actionError || data.error}</p>}
          <div className="flex gap-2 flex-wrap">
            <button type="submit" disabled={busy || !folder.trim() || !model.trim()} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              {busy ? 'Setting up…' : data.configured ? 'Apply and reconnect' : data.installed ? 'Set up connector' : 'Install and connect'}
            </button>
            {data.configured && <button type="button" disabled={busy} onClick={() => void remove()} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-on-surface-variant hover:text-error disabled:opacity-50 cursor-pointer"><Unplug className="w-4 h-4" />Remove connector</button>}
          </div>
        </form>
      ) : null}
    </section>
  );
}

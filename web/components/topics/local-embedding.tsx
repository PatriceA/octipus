'use client';

/**
 * The optional local embedding engine on the Embedding lane (docs/RAG.md →
 * Local embeddings): llama.cpp and a small model, downloaded and verified on
 * the server when an admin asks. Binds the model only while the lane is
 * unbound; an embedding model already in use is never replaced.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface LocalEngineJob {
  stage: 'engine' | 'model' | 'probe' | 'register' | 'done' | 'error';
  percent: number;
  statusText: string;
  error?: string;
  note?: string;
  finishedAt?: number;
}

export interface LocalEngineState {
  platform: string | null;
  engine: { tag: string; installed: boolean };
  models: Array<{ id: string; label: string; sizeBytes: number; default: boolean; installed: boolean; bound: boolean }>;
  embeddingBound: string | null;
  process: { running: boolean; model?: string };
  job: LocalEngineJob | null;
}

const busyStage = (job: LocalEngineJob | null | undefined) => !!job && job.stage !== 'done' && job.stage !== 'error';
const mb = (bytes: number) => Math.round(bytes / 1e6);

export function LocalEmbeddingPanel({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(false);
  const { data } = useQuery({
    queryKey: ['local-engine'],
    queryFn: () => api.get<LocalEngineState>('/local-engine'),
    refetchInterval: (q) => (busyStage(q.state.data?.job) ? 1500 : false),
  });
  // An install that finishes while this card follows it: reload the lanes once.
  const followed = useRef(false);
  const stage = data?.job?.stage;
  useEffect(() => {
    if (busyStage(data?.job)) followed.current = true;
    else if (stage === 'done' && followed.current) {
      followed.current = false;
      onChanged();
    }
  }, [data?.job, stage, onChanged]);
  if (!data?.platform) return null;
  const model = data.models.find((m) => m.default) ?? data.models[0];
  if (!model) return null;
  const job = data.job;
  const busy = busyStage(job);
  const installed = data.engine.installed && data.models.some((m) => m.installed);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['local-engine'] });
    onChanged();
  };
  const install = async () => {
    setError('');
    try {
      await api.post('/local-engine/install', {});
      await qc.invalidateQueries({ queryKey: ['local-engine'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the install');
    }
  };
  const remove = async () => {
    if (!window.confirm('Remove the local embedding engine and its model files? A bound local model is unbound; search stays off until another embedding model is set.')) return;
    setRemoving(true);
    setError('');
    try {
      await api.delete('/local-engine');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove it');
    } finally {
      setRemoving(false);
    }
  };
  const btn = 'px-2 py-0.5 text-[11px] rounded bg-surface-container-high text-on-surface-variant hover:text-on-surface disabled:opacity-50 cursor-pointer';
  return (
    <div className="mt-1.5 text-[11px] text-on-surface-variant" data-testid="local-embedding">
      {busy && job ? (
        <div className="flex items-center gap-2" role="status">
          <span>{job.statusText}</span>
          {(job.stage === 'engine' || job.stage === 'model') && (
            <span className="inline-block w-24 h-1 rounded bg-surface-container-high overflow-hidden" aria-hidden>
              <span className="block h-full bg-primary" style={{ width: `${job.percent}%` }} />
            </span>
          )}
        </div>
      ) : installed ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span>
            Local engine installed ({data.models.filter((m) => m.installed).map((m) => m.label).join(', ')})
            {data.process.running ? ' · running' : ' · starts when needed'}
          </span>
          <button type="button" className={btn} disabled={removing} onClick={remove}>{removing ? '…' : 'Remove'}</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" className={btn} onClick={install} data-testid="install-local-embedding">
            Install local embeddings ({model.label}, ~{mb(model.sizeBytes) + 30} MB)
          </button>
          <span>{data.embeddingBound ? `${data.embeddingBound} stays in use; bind the local model here to switch (vectors are rebuilt).` : 'Free, no key; runs on this server.'}</span>
        </div>
      )}
      {job?.stage === 'error' && <p className="text-error mt-0.5">Install failed: {job.error}</p>}
      {job?.stage === 'done' && job.note && <p className="mt-0.5">{job.note}</p>}
      {error && <p className="text-error mt-0.5">{error}</p>}
    </div>
  );
}

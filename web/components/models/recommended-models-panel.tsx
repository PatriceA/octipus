'use client';

import { Check, Cpu, Download, HardDrive, Sparkles, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

// API response shapes for the hwfit recommender (mirrors src/capabilities/hwfit).
interface DetectedGpu {
  vendor: string;
  name: string;
  vramMB: number;
}
interface HardwareProfile {
  gpus: DetectedGpu[];
  totalVramMB: number;
  ramMB: number;
  cpu: { cores: number; arch: string };
  platform: string;
  source: string[];
}
interface SizedModel {
  id: string;
  family: string;
  quant: string;
  topics: string[];
  contextWindow: number;
  vramMB: number;
  sizeSource: 'live' | 'hint';
  notes?: string;
}
interface ScoredModel {
  entry: SizedModel;
  fits: boolean;
  fitMargin: number;
  recommended: boolean;
  note?: string;
}
interface RecommendResponse {
  hardware?: HardwareProfile;
  scored?: ScoredModel[];
  error?: string;
}
interface InstallJob {
  id: string;
  modelId: string;
  status: 'pulling' | 'registering' | 'done' | 'error';
  percent: number;
  statusText: string;
  modelName?: string;
  error?: string;
}

const fmtGB = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

export interface RecommendedModelsPanelProps {
  /** Called after a model is successfully installed + bound, to refresh the list. */
  onInstalled: () => void;
}

export function RecommendedModelsPanel({ onInstalled }: RecommendedModelsPanelProps) {
  const [scanning, setScanning] = useState(false);
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [scored, setScored] = useState<ScoredModel[]>([]);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  // modelId → live install job (progress / outcome).
  const [jobs, setJobs] = useState<Record<string, InstallJob>>({});

  const scan = async () => {
    setScanning(true);
    setError('');
    try {
      const res = await api.post<RecommendResponse>('/models/recommend');
      if (res.error) {
        setError(res.error);
        return;
      }
      setHardware(res.hardware ?? null);
      setScored(res.scored ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const install = async (entry: SizedModel) => {
    try {
      const res = await api.post<{ jobId?: string; error?: string }>('/models/install', {
        id: entry.id,
        bindTopics: entry.topics,
      });
      if (res.error || !res.jobId) {
        setJobs((j) => ({ ...j, [entry.id]: errorJob(entry.id, res.error ?? 'Install failed to start') }));
        return;
      }
      pollJob(res.jobId, entry.id);
    } catch (err) {
      setJobs((j) => ({ ...j, [entry.id]: errorJob(entry.id, (err as Error).message) }));
    }
  };

  // Poll install progress until the job finishes. (A WS progress stream can
  // replace this later; polling keeps the panel self-contained.)
  const pollJob = (jobId: string, modelId: string) => {
    const deadline = Date.now() + 35 * 60_000; // stop polling after ~35 min
    const tick = async () => {
      if (Date.now() > deadline) {
        setJobs((j) => ({ ...j, [modelId]: errorJob(modelId, 'Install timed out — check the server.') }));
        return;
      }
      try {
        const job = await api.get<InstallJob>(`/models/install/${jobId}`);
        setJobs((j) => ({ ...j, [modelId]: job }));
        if (job.status === 'done') {
          onInstalled();
          return;
        }
        if (job.status === 'error') return;
      } catch {
        // transient; keep polling
      }
      setTimeout(tick, 1000);
    };
    setJobs((j) => ({ ...j, [modelId]: { id: jobId, modelId, status: 'pulling', percent: 0, statusText: 'starting' } }));
    setTimeout(tick, 600);
  };

  const visible = showAll ? scored : scored.filter((s) => s.recommended || s.fits);

  return (
    <div className="border border-outline-variant/10 rounded-xs bg-surface-container-low p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xs bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-4.5 h-4.5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold text-on-surface">Recommended for your hardware</h2>
            <p className="text-sm text-on-surface-variant">
              Scan this machine and install a local model that fits, served via Ollama.
            </p>
          </div>
        </div>
        <button
          onClick={scan}
          disabled={scanning}
          className="px-4 py-2 bg-linear-to-r from-primary to-primary-container text-on-primary rounded-full hover:opacity-90 disabled:opacity-50 cursor-pointer font-medium whitespace-nowrap"
        >
          {scanning ? 'Scanning…' : hardware ? 'Re-scan' : 'Scan hardware'}
        </button>
      </div>

      {error && (
        <div className="bg-error/10 border border-error/20 rounded-xs px-3 py-2 text-error text-sm">{error}</div>
      )}

      {hardware && (
        <div className="flex flex-wrap gap-3 text-sm text-on-surface-variant">
          <span className="inline-flex items-center gap-1.5">
            <HardDrive className="w-4 h-4" />
            {hardware.gpus.length > 0
              ? `${hardware.gpus.map((g) => g.name).join(', ')} · ${fmtGB(hardware.totalVramMB)} VRAM`
              : 'No GPU detected (CPU-only)'}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="w-4 h-4" />
            {hardware.cpu.cores} cores · {fmtGB(hardware.ramMB)} RAM
          </span>
          <span className="text-xs opacity-70">detected via {hardware.source.join(', ')}</span>
        </div>
      )}

      {visible.length > 0 && (
        <div className="space-y-2">
          {visible.map((s) => (
            <ModelRow key={s.entry.id} scored={s} hardware={hardware} job={jobs[s.entry.id]} onInstall={() => install(s.entry)} />
          ))}
          {scored.length > visible.length && (
            <button
              onClick={() => setShowAll(true)}
              className="text-sm text-primary hover:underline cursor-pointer"
            >
              Show {scored.length - visible.length} more (don&apos;t fit this hardware)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ModelRow({
  scored,
  hardware,
  job,
  onInstall,
}: {
  scored: ScoredModel;
  hardware: HardwareProfile | null;
  job?: InstallJob;
  onInstall: () => void;
}) {
  const { entry, fits, recommended, note } = scored;
  const budgetRef = hardware?.totalVramMB || entry.vramMB;
  const barPct = Math.min(100, Math.round((entry.vramMB / Math.max(budgetRef, 1)) * 100));
  const installed = job?.status === 'done';

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xs border border-outline-variant/10 bg-surface">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-on-surface truncate">{entry.id}</span>
          {recommended && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
              Recommended
            </span>
          )}
          {entry.topics.map((t) => (
            <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-container-high text-on-surface-variant">
              {t}
            </span>
          ))}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <div className="h-1.5 w-28 rounded-full bg-surface-container-high overflow-hidden">
            <div className={`h-full ${fits ? 'bg-primary' : 'bg-error'}`} style={{ width: `${barPct}%` }} />
          </div>
          <span className="text-xs text-on-surface-variant">
            {fmtGB(entry.vramMB)} {entry.sizeSource === 'live' ? '' : '(est.)'}
          </span>
          {!fits && (
            <span className="text-xs text-error inline-flex items-center gap-1">
              <TriangleAlert className="w-3 h-3" /> tight fit
            </span>
          )}
        </div>
        {(note || job?.error) && <p className="mt-1 text-xs text-error">{job?.error ?? note}</p>}
      </div>

      <div className="shrink-0">
        {installed ? (
          <span className="inline-flex items-center gap-1 text-sm text-primary">
            <Check className="w-4 h-4" /> Installed
          </span>
        ) : job && job.status !== 'error' ? (
          <div className="w-28">
            <div className="h-1.5 rounded-full bg-surface-container-high overflow-hidden">
              <div className="h-full bg-primary transition-all" style={{ width: `${job.percent}%` }} />
            </div>
            <span className="text-xs text-on-surface-variant capitalize">{job.status} {job.percent}%</span>
          </div>
        ) : (
          <button
            onClick={onInstall}
            className="px-3 py-1.5 text-sm border border-outline-variant/20 rounded-full hover:bg-surface-container-high cursor-pointer inline-flex items-center gap-1.5 text-on-surface"
          >
            <Download className="w-3.5 h-3.5" />
            Install
          </button>
        )}
      </div>
    </div>
  );
}

function errorJob(modelId: string, message: string): InstallJob {
  return { id: '', modelId, status: 'error', percent: 0, statusText: 'error', error: message };
}

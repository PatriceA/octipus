'use client';

import { CheckCircle, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import type {
  InstallableEngine, SpeechCatalogEntry, SpeechDirection, SpeechEngineBound, SpeechEngineRow, SpeechInstallJob, SpeechOverview, VoiceProfile,
} from '@/lib/types/voice';
import { EngineEdit } from './engine-edit';
import { HearTest, SpeakTest } from './engine-test';
import { Badge, Busy, Check, dangerBtn, errorText, Field, InlineError, inputCls, primaryBtn, quietBtn, Section, SubHeading } from './ui';

const TITLES: Record<SpeechDirection, { title: string; description: string; lane: 'transcription' | 'speech' }> = {
  stt: { title: 'Hear (speech to text)', description: 'What turns your voice into text: dictation, voice conversations, voice notes and phone calls.', lane: 'transcription' },
  tts: { title: 'Speak (text to speech)', description: 'What reads replies aloud: voice conversations, voice notes and phone calls.', lane: 'speech' },
};

const where = (local: boolean) => (local ? 'on this machine' : 'cloud');
const boundText = (answer: SpeechEngineBound) =>
  answer.bound === 'not-bound' ? `${answer.model} was added. Another engine is still the primary.` : `${answer.model} is now the primary.`;

/** What an installable engine needs on the server that is not there. */
function missingFor(kind: SpeechCatalogEntry['kind'], host: SpeechOverview['host']): string[] {
  const needs = kind === 'fasterwhisper' ? ['uv', 'ffmpeg'] as const : kind === 'kokoro' ? ['uv'] as const : [];
  return needs.filter((tool) => !host[tool]);
}

interface Props {
  direction: SpeechDirection;
  overview: SpeechOverview;
  /** Speak only: the voices a test can be played in. */
  profiles?: VoiceProfile[];
  /** Something changed on the server: read the overview again. */
  onChanged: () => void;
}

/** One direction of speech: what serves it, the engines registered for it, adding one, and trying it. */
export function EnginesSection({ direction, overview, profiles = [], onChanged }: Props) {
  const { title, description, lane } = TITLES[direction];
  const serving = direction === 'stt' ? overview.hear : overview.speak;
  const engines = overview.engines.filter((engine) => engine.direction === direction);
  const catalog = overview.catalog.filter((entry) => entry.direction === direction);
  const primary = engines.find((engine) => engine.role === 'primary');

  return (
    <Section title={title} description={description} testId={`voice-${direction}`}>
      <p className="flex items-start gap-1.5 text-sm" data-testid={`voice-status-${direction}`}>
        {serving.available ? (
          <>
            <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-tertiary" aria-hidden />
            <span className="text-on-surface">Now: <strong>{serving.model ?? serving.engine}</strong> · {where(serving.local)}</span>
          </>
        ) : (
          <>
            <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-on-surface-variant" aria-hidden />
            <span className="text-on-surface-variant">Off — {serving.reason ?? 'no engine is set up.'}</span>
          </>
        )}
      </p>

      <div className="space-y-2">
        <SubHeading>Engines</SubHeading>
        {engines.length === 0 && <p className="text-xs text-on-surface-variant">None yet. Add one below.</p>}
        <ul className="space-y-2">
          {engines.map((engine) => (
            <EngineRow key={engine.name} engine={engine} lane={lane} primary={primary} onChanged={onChanged} />
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <SubHeading>Add an engine</SubHeading>
        <ul className="space-y-2">
          {catalog.map((entry) => (
            <CatalogRow
              key={entry.kind}
              entry={entry}
              host={overview.host}
              job={overview.jobs.find((job) => job.engine === entry.kind)}
              onChanged={onChanged}
            />
          ))}
        </ul>
        <OwnServerForm direction={direction} onChanged={onChanged} />
      </div>

      <div className="space-y-2">
        <SubHeading>Test</SubHeading>
        {direction === 'stt' ? <HearTest engines={engines} /> : <SpeakTest engines={engines} profiles={profiles} />}
      </div>
    </Section>
  );
}

function EngineRow({ engine, lane, primary, onChanged }: { engine: SpeechEngineRow; lane: 'transcription' | 'speech'; primary: SpeechEngineRow | undefined; onChanged: () => void }) {
  const [busy, setBusy] = useState<'primary' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);
  const editable = engine.kind === 'compatible' || engine.kind === 'fasterwhisper';

  const run = async (what: 'primary' | 'remove', action: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await action();
      setConfirmRemove(false);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  // The engine it replaces stays as the backup, so nothing that worked stops working.
  const makePrimary = () => run('primary', () => api.put(`/topics/${lane}/binding`, {
    primaryModel: engine.name,
    backupModel: primary && primary.name !== engine.name ? primary.name : null,
  }));
  const remove = () => run('remove', () => api.delete(`/voice/engines/${encodeURIComponent(engine.name)}`));

  return (
    <li className="rounded-lg bg-surface-container-high/60 p-3 space-y-2" data-testid="engine-row" data-engine={engine.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-on-surface">{engine.name}</span>
            {engine.role === 'primary' && <Badge tone="primary">Primary</Badge>}
            {engine.role === 'backup' && <Badge>Backup</Badge>}
            <Badge>{where(engine.local)}</Badge>
          </div>
          <p className="text-xs text-on-surface-variant break-all">
            Model <code>{engine.modelId}</code>
            {engine.endpoint && <> · at <code>{engine.endpoint}</code></>}
          </p>
          {engine.available ? (
            <p className="text-xs text-tertiary">Can run</p>
          ) : (
            <p className="text-xs text-warning">
              Cannot run: {engine.reason ?? 'the reason is not known.'}
              {!engine.local && <> A missing key is added under <Link href="/secrets" className="underline">Secrets</Link>.</>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {engine.role !== 'primary' && (
            <button type="button" className={quietBtn} disabled={busy !== null} onClick={makePrimary}>
              <Busy on={busy === 'primary'} /> Make primary
            </button>
          )}
          {editable && (
            <button type="button" className={quietBtn} aria-expanded={editing} onClick={() => setEditing((open) => !open)}>
              {editing ? 'Close' : 'Edit'}
            </button>
          )}
          {confirmRemove ? (
            <>
              <button type="button" className={dangerBtn} disabled={busy !== null} onClick={remove}>
                <Busy on={busy === 'remove'} /> Remove {engine.name}
              </button>
              <button type="button" className={quietBtn} disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Cancel</button>
            </>
          ) : (
            <button type="button" className={dangerBtn} onClick={() => setConfirmRemove(true)}>Remove</button>
          )}
        </div>
      </div>
      {confirmRemove && (
        <p className="text-xs text-on-surface-variant">
          Removing takes it out of this list{engine.role ? ' and off its place as ' + engine.role : ''}. Files a local engine downloaded stay on disk.
        </p>
      )}
      <InlineError message={error} />
      {editing && <EngineEdit engine={engine} onSaved={() => { setEditing(false); onChanged(); }} />}
    </li>
  );
}

function CatalogRow({ entry, host, job, onChanged }: { entry: SpeechCatalogEntry; host: SpeechOverview['host']; job: SpeechInstallJob | undefined; onChanged: () => void }) {
  const [size, setSize] = useState(entry.sizes?.find((s) => s.id === 'small')?.id ?? entry.sizes?.[0]?.id ?? '');
  const [otherModel, setOtherModel] = useState('');
  const [modelPath, setModelPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const missing = entry.installable ? missingFor(entry.kind, host) : [];
  const running = job?.stage === 'running';

  const act = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await action());
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const install = () => act(async () => {
    const model = otherModel.trim() || size;
    await api.post<{ job: SpeechInstallJob }>('/voice/engines/install', {
      engine: entry.kind as InstallableEngine,
      ...(entry.kind === 'fasterwhisper' && model ? { size: model } : {}),
    });
    return null;
  });
  const use = () => act(async () => boundText(await api.post<SpeechEngineBound>('/voice/engines/use', {
    direction: entry.direction,
    engine: entry.kind,
    ...(entry.kind === 'piper' && modelPath.trim() ? { modelPath: modelPath.trim() } : {}),
    makePrimary: true,
  })));

  return (
    <li className="rounded-lg bg-surface-container-high/60 p-3 space-y-2" data-testid="catalog-row" data-engine={entry.kind}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-on-surface">{entry.label}</span>
            <Badge>{where(entry.local)}</Badge>
          </div>
          <p className="text-xs text-on-surface-variant">{entry.note}</p>
          {!entry.local && (
            <p className="text-xs text-on-surface-variant">
              Its API key is kept under <Link href="/secrets" className="text-primary underline">Secrets</Link>; after adding it, the list above says whether the key was found.
            </p>
          )}
          {missing.length > 0 && (
            <p className="text-xs text-warning" data-testid="missing-tools">
              Not found on this server: {missing.join(' and ')}. Install {missing.length > 1 ? 'them' : 'it'} there first, or this install will fail.
            </p>
          )}
        </div>
        {entry.installable ? (
          <button type="button" className={primaryBtn} disabled={busy || running} onClick={install}>
            <Busy on={busy || running} /> {running ? 'Installing…' : 'Install'}
          </button>
        ) : (
          <button type="button" className={primaryBtn} disabled={busy} onClick={use}>
            <Busy on={busy} /> Use
          </button>
        )}
      </div>

      {entry.sizes && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Model">
            <select className={inputCls} value={size} disabled={running || otherModel.trim() !== ''} onChange={(event) => setSize(event.target.value)}>
              {entry.sizes.map((s) => (
                <option key={s.id} value={s.id}>{s.id} — {s.download} download, {s.ram} memory. {s.note}</option>
              ))}
            </select>
          </Field>
          <Field label="Or another model" hint="Any Whisper model name, such as large-v3-turbo, or a Hugging Face repository (owner/name).">
            <input className={inputCls} value={otherModel} disabled={running} placeholder="large-v3-turbo" onChange={(event) => setOtherModel(event.target.value)} />
          </Field>
        </div>
      )}
      {entry.kind === 'piper' && (
        <Field label="Voice file (.onnx) path" hint="The full path of the Piper voice file on the server.">
          <input className={inputCls} value={modelPath} placeholder="/home/you/piper/en_US-lessac-medium.onnx" onChange={(event) => setModelPath(event.target.value)} />
        </Field>
      )}

      {job && <InstallJob job={job} />}
      {done && <p className="text-xs text-tertiary" role="status">{done}</p>}
      <InlineError message={error} />
    </li>
  );
}

/** An install running on the server (or how the last one ended), with the end of its output. */
function InstallJob({ job }: { job: SpeechInstallJob }) {
  const lines = job.log.slice(-6);
  return (
    <div className="space-y-1.5" data-testid="install-job" data-stage={job.stage}>
      {job.stage === 'running' && (
        <p className="flex items-center gap-1.5 text-xs text-on-surface" role="status">
          <Busy on /> Installing{job.size ? ` ${job.size}` : ''} on the server. This can take a few minutes; you can leave this page.
        </p>
      )}
      {job.stage === 'done' && (
        <p className="text-xs text-tertiary" role="status">
          Installed{job.model ? ` as ${job.model}` : ''}.
          {job.bound === 'primary' && ' It is now the primary.'}
          {job.bound === 'not-bound' && ' Another engine is still the primary: use “Make primary” above to switch.'}
        </p>
      )}
      {job.stage === 'error' && <InlineError message={`The install failed: ${job.error ?? 'no reason was given.'}`} testId="install-error" />}
      {lines.length > 0 && job.stage !== 'done' && (
        <pre className="max-h-40 overflow-auto rounded bg-surface-container-lowest p-2 text-[11px] leading-snug text-on-surface-variant whitespace-pre-wrap" data-testid="install-log">
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

function OwnServerForm({ direction, onChanged }: { direction: SpeechDirection; onChanged: () => void }) {
  const [endpoint, setEndpoint] = useState('');
  const [modelId, setModelId] = useState('');
  const [name, setName] = useState('');
  const [apiKeyRef, setApiKeyRef] = useState('');
  const [makePrimary, setMakePrimary] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const answer = await api.post<SpeechEngineBound>('/voice/engines/server', {
        direction,
        endpoint: endpoint.trim(),
        modelId: modelId.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(apiKeyRef.trim() ? { apiKeyRef: apiKeyRef.trim() } : {}),
        makePrimary,
      });
      setDone(boundText(answer));
      setEndpoint('');
      setModelId('');
      setName('');
      setApiKeyRef('');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={add} className="rounded-lg bg-surface-container-high/60 p-3 space-y-3" data-testid={`own-server-${direction}`} aria-label="Your own speech server">
      <div>
        <span className="text-sm font-medium text-on-surface">Your own speech server</span>
        <p className="text-xs text-on-surface-variant mt-0.5">
          Works with any OpenAI-compatible speech server (Speaches, vLLM-Omni, LocalAI, NVIDIA NeMo-Speech, Groq…).
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Endpoint URL">
          <input className={inputCls} required value={endpoint} placeholder="http://localhost:8000/v1" onChange={(event) => setEndpoint(event.target.value)} />
        </Field>
        <Field label="Model id" hint="What the server calls the model.">
          <input className={inputCls} required value={modelId} placeholder={direction === 'stt' ? 'openai/whisper-large-v3-turbo' : 'openbmb/VoxCPM2'} onChange={(event) => setModelId(event.target.value)} />
        </Field>
        <Field label="Name (optional)" hint="How it is listed here.">
          <input className={inputCls} value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="API key name (optional)" hint={<>The name of a secret under <Link href="/secrets" className="text-primary underline">Secrets</Link>, or <code>env:NAME</code> for an environment variable on the server. Empty when the server needs no key.</>}>
          <input className={inputCls} value={apiKeyRef} placeholder="my_speech_key" onChange={(event) => setApiKeyRef(event.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Check label="Make it the primary" checked={makePrimary} onChange={setMakePrimary} />
        <button type="submit" className={primaryBtn} disabled={busy}>
          <Busy on={busy} /> Add server
        </button>
      </div>
      {done && <p className="text-xs text-tertiary" role="status">{done}</p>}
      <InlineError message={error} testId={`own-server-error-${direction}`} />
    </form>
  );
}

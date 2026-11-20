'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { SpeechEngineBound, SpeechEngineRow, SpeechSettingsInput, VoiceDescriptionMode } from '@/lib/types/voice';
import { Busy, Check, errorText, Field, InlineError, inputCls, primaryBtn } from './ui';

type Device = 'auto' | 'cpu' | 'cuda';
type Realtime = 'off' | 'openai' | 'nemo';

const asDevice = (value: string | null): Device => (value === 'cpu' || value === 'cuda' ? value : 'auto');
const asRealtime = (value: string | null): Realtime => (value === 'openai' || value === 'nemo' ? value : 'off');

/**
 * The settings of one engine that matter. Your own speech server: where it
 * is and what it takes. faster-whisper: which processor it runs on.
 */
export function EngineEdit({ engine, onSaved }: { engine: SpeechEngineRow; onSaved: () => void }) {
  return engine.kind === 'fasterwhisper'
    ? <FasterWhisperEdit engine={engine} onSaved={onSaved} />
    : <ServerEdit engine={engine} onSaved={onSaved} />;
}

function FasterWhisperEdit({ engine, onSaved }: { engine: SpeechEngineRow; onSaved: () => void }) {
  const [device, setDevice] = useState<Device>(asDevice(engine.speech.device));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/voice/engines/${encodeURIComponent(engine.name)}`, { speech: { device } satisfies SpeechSettingsInput });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3 border-t border-outline-variant/20 pt-3" data-testid="engine-edit">
      <Field label="Runs on" hint="Automatic uses a graphics card when there is one.">
        <select className={inputCls} value={device} onChange={(event) => setDevice(asDevice(event.target.value))}>
          <option value="auto">Automatic</option>
          <option value="cpu">Processor (CPU)</option>
          <option value="cuda">Graphics card (GPU)</option>
        </select>
      </Field>
      <button type="submit" className={primaryBtn} disabled={busy}><Busy on={busy} /> Save</button>
      <InlineError message={error} />
    </form>
  );
}

function ServerEdit({ engine, onSaved }: { engine: SpeechEngineRow; onSaved: () => void }) {
  const speaks = engine.direction === 'tts';
  const [endpoint, setEndpoint] = useState(engine.endpoint ?? '');
  const [modelId, setModelId] = useState(engine.modelId);
  const [apiKeyRef, setApiKeyRef] = useState(engine.apiKeyRef ?? '');
  const [instructions, setInstructions] = useState<VoiceDescriptionMode>(engine.speech.instructions);
  const [cloning, setCloning] = useState(engine.speech.cloning);
  const [streams, setStreams] = useState(engine.speech.streams);
  const [speed, setSpeed] = useState(engine.speech.speed);
  const [sampleRate, setSampleRate] = useState(engine.speech.sampleRate?.toString() ?? '');
  const [uploadWav, setUploadWav] = useState(engine.speech.upload === 'wav');
  const [realtime, setRealtime] = useState<Realtime>(asRealtime(engine.speech.realtime));
  const [extraBody, setExtraBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    let extra: Record<string, unknown> | undefined;
    if (extraBody.trim()) {
      try {
        const parsed: unknown = JSON.parse(extraBody);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('it must be an object, such as {"temperature": 0.2}');
        extra = parsed as Record<string, unknown>;
      } catch (err) {
        setError(`The extra request fields are not valid JSON: ${errorText(err)}`);
        return;
      }
    }
    const rate = sampleRate.trim() === '' ? null : Number(sampleRate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 8000 || rate > 96000)) {
      setError('The sample rate is a number between 8000 and 96000, or empty for the model’s own.');
      return;
    }

    // Only what was changed here. The form shows what the engine does now,
    // most of it what its model is known for; sending all of it back would
    // pin those defaults to the row, and they would stay when the model id
    // changes (a 48 kHz rate on a 24 kHz model plays at double speed).
    // `null` = not set: what the model is known for applies.
    const loaded = engine.speech;
    const speech: SpeechSettingsInput = {};
    if (speaks) {
      if (instructions !== loaded.instructions) speech.instructions = instructions;
      if (cloning !== loaded.cloning) speech.cloning = cloning;
      if (streams !== loaded.streams) speech.streams = streams;
      if (speed !== loaded.speed) speech.speed = speed;
      if (rate !== loaded.sampleRate) speech.sampleRate = rate;
    } else {
      if (uploadWav !== (loaded.upload === 'wav')) speech.upload = uploadWav ? 'wav' : 'any';
      // `off` keeps no socket even for a model known to have one; the server keeps a stored URL and rate.
      if (realtime !== asRealtime(loaded.realtime)) speech.realtime = { protocol: realtime };
    }
    if (extra) speech.extraBody = extra;

    setBusy(true);
    try {
      const where = endpoint.trim() !== (engine.endpoint ?? '') || modelId.trim() !== engine.modelId || apiKeyRef.trim() !== (engine.apiKeyRef ?? '');
      if (where) {
        // The same name updates the row (and keeps its place as primary or backup).
        await api.post<SpeechEngineBound>('/voice/engines/server', {
          direction: engine.direction,
          name: engine.name,
          endpoint: endpoint.trim(),
          modelId: modelId.trim(),
          ...(apiKeyRef.trim() ? { apiKeyRef: apiKeyRef.trim() } : {}),
          speech,
        });
      } else if (Object.keys(speech).length > 0) {
        await api.patch(`/voice/engines/${encodeURIComponent(engine.name)}`, { speech });
      }
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3 border-t border-outline-variant/20 pt-3" data-testid="engine-edit">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Endpoint URL">
          <input className={inputCls} required value={endpoint} placeholder="http://localhost:8000/v1" onChange={(event) => setEndpoint(event.target.value)} />
        </Field>
        <Field label="Model id">
          <input className={inputCls} required value={modelId} onChange={(event) => setModelId(event.target.value)} />
        </Field>
        <Field label="API key name" hint={<>A secret under <Link href="/secrets" className="text-primary underline">Secrets</Link>, or <code>env:NAME</code>. Empty when the server needs no key.</>}>
          <input className={inputCls} value={apiKeyRef} onChange={(event) => setApiKeyRef(event.target.value)} />
        </Field>
      </div>

      <details className="rounded-lg bg-surface-container/60 p-3">
        <summary className="cursor-pointer text-xs font-medium text-on-surface">Advanced</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-on-surface-variant">
            These start from what the model is known for. Change one only when this server behaves differently: only what you change is saved,
            and a new model id starts again from what that model is known for.
          </p>
          {speaks ? (
            <>
              <Field label="How a voice description is passed" hint="A description is a voice in words, such as “a calm woman in her forties”.">
                <select className={inputCls} value={instructions} onChange={(event) => setInstructions(event.target.value as VoiceDescriptionMode)}>
                  <option value="field">As its own field in the request</option>
                  <option value="prefix">At the start of the text</option>
                  <option value="none">Not supported</option>
                </select>
              </Field>
              <Check label="Takes a reference clip (can clone a voice)" checked={cloning} onChange={setCloning} />
              <Check label="Sends audio while it is generated (streams)" checked={streams} onChange={setStreams} />
              <Check label="Takes a speaking speed" checked={speed} onChange={setSpeed} />
              <Field label="Sample rate (Hz)" hint="Empty: the model’s own.">
                <input className={inputCls} type="number" min={8000} max={96000} step={1} value={sampleRate} placeholder="24000" onChange={(event) => setSampleRate(event.target.value)} />
              </Field>
            </>
          ) : (
            <>
              <Check label="Upload recordings as WAV (for servers that read nothing else)" checked={uploadWav} onChange={setUploadWav} />
              <Field label="Live transcription protocol" hint="How the server takes audio while you are still talking. None: each turn is transcribed whole when it ends.">
                <select className={inputCls} value={realtime} onChange={(event) => setRealtime(asRealtime(event.target.value))}>
                  <option value="off">None</option>
                  <option value="openai">OpenAI Realtime</option>
                  <option value="nemo">NVIDIA NeMo</option>
                </select>
              </Field>
            </>
          )}
          <Field label="Extra request fields (JSON)" hint="Sent with every request to this server. Empty: the stored ones stay (they are not shown here).">
            <textarea className={`${inputCls} font-mono`} rows={3} value={extraBody} placeholder='{"temperature": 0.2}' onChange={(event) => setExtraBody(event.target.value)} />
          </Field>
        </div>
      </details>

      <button type="submit" className={primaryBtn} disabled={busy}><Busy on={busy} /> Save</button>
      <InlineError message={error} testId="engine-edit-error" />
    </form>
  );
}

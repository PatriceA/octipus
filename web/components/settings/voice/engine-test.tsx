'use client';

import { Mic, Play } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import type { SpeechEngineRow, TranscribeAnswer, VoiceProfile } from '@/lib/types/voice';
import { audioFormatOf, blobToBase64, microphoneError, startClipRecorder } from '@/lib/voice-audio';
import { Busy, errorText, Field, InlineError, inputCls, primaryBtn } from './ui';
import { useSpeak } from './use-speak';

const RECORD_MS = 5000;
const DEFAULT_SENTENCE = 'Hello! This is how I sound when I read a reply to you.';

function EngineChoice({ engines, value, onChange }: { engines: SpeechEngineRow[]; value: string; onChange: (name: string) => void }) {
  return (
    <Field label="Engine">
      <select className={inputCls} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">The one in use</option>
        {engines.map((engine) => <option key={engine.name} value={engine.name}>{engine.name}</option>)}
      </select>
    </Field>
  );
}

/** Record five seconds and show what the server heard, which engine answered and how long it took. */
export function HearTest({ engines }: { engines: SpeechEngineRow[] }) {
  const [engine, setEngine] = useState('');
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [result, setResult] = useState<{ text: string; model: string | null; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setResult(null);
    let clip: Blob;
    try {
      const recorder = await startClipRecorder(RECORD_MS);
      setPhase('recording');
      clip = await recorder.done;
    } catch (err) {
      setPhase('idle');
      setError(err instanceof DOMException ? microphoneError(err) : errorText(err));
      return;
    }
    setPhase('transcribing');
    const started = performance.now();
    try {
      const answer = await api.post<TranscribeAnswer>('/voice/transcribe', {
        audio: await blobToBase64(clip),
        format: audioFormatOf(clip.type),
        ...(engine ? { model: engine } : {}),
      });
      // A transcription that failed answers 200 with `error`.
      if (answer.error) setError(answer.error);
      else setResult({ text: answer.text ?? '', model: answer.model ?? null, ms: Math.round(performance.now() - started) });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPhase('idle');
    }
  };

  return (
    <div className="space-y-3" data-testid="hear-test">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64 max-w-full"><EngineChoice engines={engines} value={engine} onChange={setEngine} /></div>
        <button type="button" className={primaryBtn} disabled={phase !== 'idle'} onClick={run}>
          {phase === 'idle' ? <Mic className="w-3.5 h-3.5" aria-hidden /> : <Busy on />}
          {phase === 'recording' ? 'Recording… speak now' : phase === 'transcribing' ? 'Transcribing…' : 'Record 5 seconds and transcribe'}
        </button>
      </div>
      {result && (
        <div className="text-sm space-y-1" data-testid="hear-result" role="status">
          <p className="text-on-surface">{result.text ? <>“{result.text}”</> : <span className="text-on-surface-variant">Nothing was heard in the recording.</span>}</p>
          <p className="text-xs text-on-surface-variant">Heard by {result.model ?? 'an engine that did not give its name'} in {(result.ms / 1000).toFixed(1)} s.</p>
        </div>
      )}
      <InlineError message={error} testId="hear-error" />
    </div>
  );
}

/** Say a sentence and show which engine spoke it and how long the audio took to arrive. */
export function SpeakTest({ engines, profiles }: { engines: SpeechEngineRow[]; profiles: VoiceProfile[] }) {
  const { speak, busy } = useSpeak();
  const [engine, setEngine] = useState('');
  const [profile, setProfile] = useState('');
  const [text, setText] = useState(DEFAULT_SENTENCE);
  const [result, setResult] = useState<{ engine: string | null; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setResult(null);
    try {
      const spoken = await speak('test', { text, ...(engine ? { model: engine } : {}), ...(profile ? { profile } : {}) });
      setResult({ engine: spoken.engine, ms: spoken.ms });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <form onSubmit={run} className="space-y-3" data-testid="speak-test">
      <Field label="Say">
        <input className={inputCls} required maxLength={500} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-64 max-w-full"><EngineChoice engines={engines} value={engine} onChange={setEngine} /></div>
        <div className="w-64 max-w-full">
          <Field label="Voice">
            <select className={inputCls} value={profile} onChange={(event) => setProfile(event.target.value)}>
              <option value="">The active voice</option>
              {profiles.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </Field>
        </div>
        <button type="submit" className={primaryBtn} disabled={busy !== null}>
          {busy ? <Busy on /> : <Play className="w-3.5 h-3.5" aria-hidden />} Play
        </button>
      </div>
      {result && (
        <p className="text-xs text-on-surface-variant" data-testid="speak-result" role="status">
          Spoken by {result.engine ?? 'an engine that did not give its name'}; the audio arrived after {(result.ms / 1000).toFixed(1)} s.
        </p>
      )}
      <InlineError message={error} testId="speak-error" />
    </form>
  );
}

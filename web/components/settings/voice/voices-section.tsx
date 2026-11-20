'use client';

import { Mic, Play, Square } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { SpeechEngineRow, VoiceProfile, VoiceProfileInput, VoicesAnswer } from '@/lib/types/voice';
import { blobToBase64, type ClipRecorder, microphoneError, startClipRecorder } from '@/lib/voice-audio';
import { Badge, Busy, Check, dangerBtn, errorText, Field, InlineError, inputCls, primaryBtn, quietBtn, Section, SubHeading } from './ui';
import { useSpeak } from './use-speak';

const PREVIEW_SENTENCE = 'This is the voice I will speak in. How does it sound to you?';
const CLONE_RECORD_MS = 15_000;
const MAX_CLIP_BYTES = 10 * 1024 * 1024;

type Way = 'pick' | 'describe' | 'clone';

/** What a profile is made of, in a few words. */
function madeOf(profile: Pick<VoiceProfile, 'voice' | 'instructions' | 'hasClip'>): string {
  const parts = [
    profile.voice && `the engine’s voice “${profile.voice}”`,
    profile.instructions && 'a description',
    profile.hasClip && 'a reference clip',
  ].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'nothing yet';
}

interface Props {
  voices: VoicesAnswer;
  /** The engine replies are spoken with now: what a new voice can be made of depends on it. */
  engine: SpeechEngineRow | undefined;
  onChanged: () => void;
}

/** Voice profiles: the voice replies are spoken in, the ones saved, and making a new one. */
export function VoicesSection({ voices, engine, onChanged }: Props) {
  const { speak, busy: speaking } = useSpeak();
  const [editing, setEditing] = useState<VoiceProfile | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  const setActive = (name: string) => run('active', () => api.post('/voice/profiles/active', { name }));
  const remove = (name: string) => run(`delete:${name}`, async () => {
    await api.delete(`/voice/profiles/${encodeURIComponent(name)}`);
    setConfirmDelete(null);
  });
  const play = async (profile: VoiceProfile) => {
    setError(null);
    try {
      await speak(`profile:${profile.name}`, { text: PREVIEW_SENTENCE, profile: profile.name });
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <Section
      title="Voices"
      description="A voice is saved under a name: one the engine offers, one you describe in words, or one cloned from a short recording."
      testId="voice-voices"
    >
      {!engine && (
        <p className="text-xs text-on-surface-variant">
          Voices are spoken by the primary engine under Speak. There is none yet{voices.reason ? `: ${voices.reason}` : '.'}
        </p>
      )}

      <div className="max-w-sm">
        <Field label="Replies are spoken in" hint="Used for voice conversations, voice notes and phone calls.">
          <select className={inputCls} value={voices.active} disabled={busy !== null} onChange={(event) => setActive(event.target.value)} data-testid="active-voice">
            <option value="">Engine default</option>
            {voices.profiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}</option>)}
          </select>
        </Field>
      </div>

      <div className="space-y-2">
        <SubHeading>Saved voices</SubHeading>
        {voices.profiles.length === 0 && <p className="text-xs text-on-surface-variant">None yet.</p>}
        <ul className="space-y-2">
          {voices.profiles.map((profile) => (
            <li key={profile.name} className="rounded-lg bg-surface-container-high/60 p-3 space-y-2" data-testid="voice-profile" data-profile={profile.name}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium text-on-surface">{profile.name}</span>
                    {voices.active === profile.name && <Badge tone="primary">In use</Badge>}
                  </div>
                  {profile.description && <p className="text-xs text-on-surface-variant">{profile.description}</p>}
                  <p className="text-xs text-on-surface-variant">
                    Made of {madeOf(profile)}{profile.model ? `, for ${profile.model}` : ''}.
                    {profile.model && engine && profile.model !== engine.name && ' That is not the engine in use now, so this voice is not applied.'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" className={quietBtn} disabled={speaking !== null} onClick={() => play(profile)}>
                    {speaking === `profile:${profile.name}` ? <Busy on /> : <Play className="w-3 h-3" aria-hidden />} Play
                  </button>
                  <button type="button" className={quietBtn} onClick={() => setEditing(profile)}>Edit</button>
                  {confirmDelete === profile.name ? (
                    <>
                      <button type="button" className={dangerBtn} disabled={busy !== null} onClick={() => remove(profile.name)}>
                        <Busy on={busy === `delete:${profile.name}`} /> Delete {profile.name}
                      </button>
                      <button type="button" className={quietBtn} onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </>
                  ) : (
                    <button type="button" className={dangerBtn} onClick={() => setConfirmDelete(profile.name)}>Delete</button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <InlineError message={error} testId="voices-error" />

      {editing ? (
        <ProfileForm
          key={editing === 'new' ? 'new' : editing.name}
          profile={editing === 'new' ? null : editing}
          engine={engine}
          engineVoices={voices.voices}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged(); }}
        />
      ) : (
        <button type="button" className={primaryBtn} onClick={() => setEditing('new')}>New voice</button>
      )}
    </Section>
  );
}

interface FormProps {
  /** The profile being edited; null = a new one. */
  profile: VoiceProfile | null;
  engine: SpeechEngineRow | undefined;
  engineVoices: string[];
  onClose: () => void;
  onSaved: () => void;
}

function ProfileForm({ profile, engine, engineVoices, onClose, onSaved }: FormProps) {
  const { speak, playBlob, busy: speaking } = useSpeak();
  const canPick = engineVoices.length > 0;
  const canDescribe = !!engine && engine.speech.instructions !== 'none';
  const canClone = !!engine && engine.speech.cloning;
  const ways: Way[] = [canPick && 'pick', canDescribe && 'describe', canClone && 'clone'].filter((w): w is Way => !!w);

  const [name, setName] = useState(profile?.name ?? '');
  const [note, setNote] = useState(profile?.description ?? '');
  const [way, setWay] = useState<Way | null>(
    profile?.hasClip && canClone ? 'clone' : profile?.instructions && canDescribe ? 'describe' : ways[0] ?? null,
  );
  const [voice, setVoice] = useState(profile?.voice ?? '');
  const [instructions, setInstructions] = useState(profile?.instructions ?? '');
  const [refText, setRefText] = useState(profile?.refText ?? '');
  const [speed, setSpeed] = useState(profile?.speed ?? 1);
  const [makeActive, setMakeActive] = useState(false);
  /** A new reference clip (uploaded, recorded, or the kept preview of a described voice). */
  const [clip, setClip] = useState<{ blob: Blob; from: 'file' | 'recording' | 'preview' } | null>(null);
  /** The last preview of the description, and the sentence it says. */
  const [preview, setPreview] = useState<{ blob: Blob; text: string } | null>(null);
  /** The stored clip is to be removed on save. */
  const [removeClip, setRemoveClip] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<ClipRecorder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const playVoice = () => attempt(async () => {
    await speak('pick', { text: PREVIEW_SENTENCE, voice, ...(engine ? { model: engine.name } : {}) });
  });
  const previewDescription = () => attempt(async () => {
    const spoken = await speak('describe', { text: PREVIEW_SENTENCE, instructions, ...(engine ? { model: engine.name } : {}) });
    setPreview({ blob: spoken.blob, text: PREVIEW_SENTENCE });
  });
  const describe = (text: string) => {
    setInstructions(text);
    // The preview was of another description: it is no longer this voice.
    setPreview(null);
    if (clip?.from === 'preview') setClip(null);
  };
  const keepPreview = (keep: boolean) => {
    if (keep && preview) {
      setClip({ blob: preview.blob, from: 'preview' });
      setRefText(preview.text);
    } else if (clip?.from === 'preview') {
      setClip(null);
      setRefText(profile?.refText ?? '');
    }
  };
  const takeClip = (blob: Blob, from: 'file' | 'recording') => {
    if (blob.size > MAX_CLIP_BYTES) {
      setError('That clip is larger than 10 MB. 10 to 15 seconds of clear speech is enough.');
      return;
    }
    setError(null);
    setClip({ blob, from });
  };
  const record = () => attempt(async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    let recorder: ClipRecorder;
    try {
      recorder = await startClipRecorder(CLONE_RECORD_MS);
    } catch (err) {
      throw new Error(err instanceof DOMException ? microphoneError(err) : errorText(err));
    }
    recorderRef.current = recorder;
    setRecording(true);
    try {
      takeClip(await recorder.done, 'recording');
    } finally {
      setRecording(false);
      recorderRef.current = null;
    }
  });

  const keepsStoredClip = !!profile?.hasClip && !removeClip;
  const hasClip = !!clip || keepsStoredClip;
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    if (!voice && !instructions.trim() && !hasClip) {
      setError('A voice needs one of: a voice the engine offers, a description, or a reference clip.');
      return;
    }
    if (clip && !refText.trim()) {
      setError('Write what is said in the clip: the engine needs the words to copy the voice.');
      return;
    }
    setBusy(true);
    try {
      const body: VoiceProfileInput = {
        ...(note.trim() ? { description: note.trim() } : {}),
        ...(voice ? { voice } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(hasClip ? { refText: refText.trim() } : {}),
        ...(engine?.speech.speed && speed !== 1 ? { speed } : {}),
        // A voice id, a description and a clip belong to the engine they were made and heard with: the one in use.
        ...(engine ? { model: engine.name } : profile?.model ? { model: profile.model } : {}),
        // A new clip replaces the stored one; `null` removes it.
        ...(clip ? { clip: { data: await blobToBase64(clip.blob), mimeType: clip.blob.type.split(';')[0] || 'audio/webm' } } : profile?.hasClip && removeClip ? { clip: null } : {}),
        ...(makeActive ? { active: true } : {}),
      };
      await api.put(`/voice/profiles/${encodeURIComponent(trimmedName)}`, body);
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const wayLabel: Record<Way, string> = { pick: 'Pick a voice', describe: 'Describe it', clone: 'Clone from a clip' };

  return (
    <form onSubmit={save} className="rounded-lg bg-surface-container-high/60 p-3 space-y-3" data-testid="voice-profile-form" aria-label={profile ? `Edit voice ${profile.name}` : 'New voice'}>
      <SubHeading>{profile ? `Edit “${profile.name}”` : 'New voice'}</SubHeading>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <input className={inputCls} required maxLength={60} value={name} disabled={!!profile} placeholder="Calm narrator" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Note (optional)" hint="For whoever picks it later.">
          <input className={inputCls} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>

      {!engine && (
        <p className="text-xs text-warning">There is no primary engine under Speak, so a voice cannot be made or heard yet. Add one above first.</p>
      )}
      {engine && profile?.model && profile.model !== engine.name && (
        <p className="text-xs text-warning">
          This voice was made for {profile.model}. Saving it here makes it a voice for {engine.name}, the engine in use now.
        </p>
      )}
      {engine && !canDescribe && !canClone && (
        <p className="text-xs text-on-surface-variant" data-testid="voice-ways-limited">
          {engine.name} only speaks in its own voices: it cannot make one from a description or from a recording.
          An engine that can (VoxCPM2, for example) is added under Speak → Your own speech server.
        </p>
      )}

      {ways.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="How to make the voice">
          {ways.map((w) => (
            <button key={w} type="button" role="tab" aria-selected={way === w} onClick={() => setWay(w)}
              className={way === w ? primaryBtn : quietBtn}>
              {wayLabel[w]}
            </button>
          ))}
        </div>
      )}

      {way === 'pick' && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64 max-w-full">
            <Field label="Voice">
              <select className={inputCls} value={voice} onChange={(event) => setVoice(event.target.value)}>
                <option value="">— none —</option>
                {(voice && !engineVoices.includes(voice) ? [voice, ...engineVoices] : engineVoices).map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </Field>
          </div>
          <button type="button" className={quietBtn} disabled={!voice || speaking !== null} onClick={playVoice}>
            {speaking === 'pick' ? <Busy on /> : <Play className="w-3 h-3" aria-hidden />} Play
          </button>
        </div>
      )}

      {way === 'describe' && (
        <div className="space-y-2">
          <Field label="Describe the voice" hint="For example: a calm woman in her forties with a slight Scottish accent, speaking slowly.">
            <textarea className={inputCls} rows={3} maxLength={1000} value={instructions} onChange={(event) => describe(event.target.value)} />
          </Field>
          <button type="button" className={quietBtn} disabled={!instructions.trim() || speaking !== null} onClick={previewDescription}>
            {speaking === 'describe' ? <Busy on /> : <Play className="w-3 h-3" aria-hidden />} Preview
          </button>
          {preview && canClone && (
            <div className="space-y-1">
              <Check label="Keep this exact voice" checked={clip?.from === 'preview'} onChange={keepPreview} />
              <p className="text-xs text-on-surface-variant">
                A described voice is made anew for every sentence, so it varies a little from one to the next. Keeping this
                preview saves it as the reference clip, and every reply then sounds like it.
              </p>
            </div>
          )}
          {preview && !canClone && (
            <p className="text-xs text-on-surface-variant">A described voice is made anew for every sentence, so it varies a little from one to the next.</p>
          )}
        </div>
      )}

      {way === 'clone' && (
        <div className="space-y-2">
          <p className="text-xs text-on-surface-variant">
            10 to 15 seconds of one person speaking clearly, with no music or noise behind them.
            {keepsStoredClip && !clip && ' A clip is already stored for this voice; a new one replaces it.'}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className={quietBtn}>
              Upload an audio file
              <input type="file" accept="audio/*" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) takeClip(file, 'file'); event.target.value = ''; }} />
            </label>
            <button type="button" className={quietBtn} onClick={record}>
              {recording ? <Square className="w-3 h-3 fill-current" aria-hidden /> : <Mic className="w-3 h-3" aria-hidden />}
              {recording ? 'Stop recording' : 'Record (up to 15 seconds)'}
            </button>
            {clip && clip.from !== 'preview' && (
              <button type="button" className={quietBtn} onClick={() => attempt(() => playBlob(clip.blob))}>
                <Play className="w-3 h-3" aria-hidden /> Play the clip
              </button>
            )}
          </div>
          {clip && <p className="text-xs text-tertiary" role="status">{clip.from === 'preview' ? 'Using the kept preview as the clip.' : `A ${clip.from === 'file' ? 'file' : 'recording'} of ${Math.max(1, Math.round(clip.blob.size / 1024))} KB is ready.`}</p>}
          <Field label="What is said in the clip" hint="The words, as they are spoken. The engine needs them to copy the voice.">
            <textarea className={inputCls} rows={2} maxLength={2000} value={refText} onChange={(event) => setRefText(event.target.value)} />
          </Field>
        </div>
      )}

      {engine?.speech.speed && (
        <div className="max-w-sm">
          <Field label={`Speed: ${speed.toFixed(2)}×`}>
            <input type="range" className="w-full accent-primary" min={0.5} max={2} step={0.05} value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
          </Field>
        </div>
      )}

      {profile?.hasClip && !clip && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant" data-testid="voice-stored-clip">
          {removeClip ? (
            <>
              <span>The stored reference clip is removed when you save.</span>
              <button type="button" className={quietBtn} onClick={() => setRemoveClip(false)}>Keep it</button>
            </>
          ) : (
            <>
              <span>A reference clip is stored for this voice.</span>
              <button type="button" className={quietBtn} onClick={() => setRemoveClip(true)}>Remove clip</button>
            </>
          )}
        </div>
      )}

      <p className="text-xs text-on-surface-variant" data-testid="voice-made-of">
        This voice is made of {madeOf({ voice: voice || undefined, instructions: instructions.trim() || undefined, hasClip })}.
      </p>
      <Check label="Speak replies in this voice from now on" checked={makeActive} onChange={setMakeActive} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={primaryBtn} disabled={busy || recording}><Busy on={busy} /> Save voice</button>
        <button type="button" className={quietBtn} onClick={onClose}>Cancel</button>
      </div>
      <InlineError message={error} testId="voice-profile-error" />
    </form>
  );
}

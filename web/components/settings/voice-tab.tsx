'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { type ModulesResponse, modulesKey, useModules } from '@/lib/modules';
import type { SpeechOverview, VoicesAnswer, VoiceStatus } from '@/lib/types/voice';
import { type SettingItem, useSettingActions } from './setting-field';
import { CallsSection } from './voice/calls-section';
import { ConversationSection } from './voice/conversation-section';
import { EnginesSection } from './voice/engines-section';
import { Busy, errorText, InlineError, primaryBtn, quietBtn } from './voice/ui';
import { VoicesSection } from './voice/voices-section';

/** How often the page looks again while an engine is being installed on the server. */
const INSTALL_POLL_MS = 1500;

/**
 * Settings → Voice: everything about speech in one place (docs/VOICE.md).
 * Hear and Speak (what turns speech into text and text into speech, and
 * adding, installing and trying an engine), Voices, how a conversation
 * behaves, and phone calls.
 */
export function VoiceTab() {
  const isAdmin = !!useAuth().user?.isAdmin;
  const modules = useModules();

  if (modules.error) return <InlineError message={`Could not tell whether voice is on: ${errorText(modules.error)}`} />;
  if (!modules.data) return <Loading />;
  if (!modules.data.enabled.includes('voice')) return <VoiceOff isAdmin={isAdmin} />;

  return (
    <div className="space-y-6" data-testid="voice-page">
      <div>
        <h2 className="text-lg font-bold text-on-surface mb-1">Voice</h2>
        <p className="text-sm text-on-surface-variant">
          Talk to your assistant and have replies read aloud: in the chat, in the mobile app and on phone calls.
        </p>
      </div>
      {isAdmin ? <AdminVoice /> : <MemberVoice />}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-12" role="status" aria-label="Loading">
      <Loader2 className="w-6 h-6 animate-spin text-on-surface-variant" />
    </div>
  );
}

/** The Voice module is off: say so, and let an admin turn it on from here. */
function VoiceOff({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      // Turns on what voice depends on too, and nothing that is on goes off.
      qc.setQueryData(modulesKey, await api.post<ModulesResponse>('/modules/enable', { ids: ['voice'] }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bg-surface-container rounded-xl p-4 space-y-3" data-testid="voice-off">
      <h2 className="text-lg font-bold text-on-surface">Voice is switched off</h2>
      <p className="text-sm text-on-surface-variant">
        Dictation, voice conversations, spoken replies and phone calls are all off, for everyone. Nothing that was set up is lost.
      </p>
      {isAdmin
        ? <button type="button" className={primaryBtn} disabled={busy} onClick={turnOn}><Busy on={busy} /> Turn it on</button>
        : <p className="text-sm text-on-surface-variant">An admin can turn it on.</p>}
      <InlineError message={error} />
    </div>
  );
}

function StatusLine({ label, available, detail }: { label: string; available: boolean; detail: string | null | undefined }) {
  return (
    <p className="flex items-start gap-1.5 text-sm">
      {available
        ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0 text-tertiary" aria-hidden />
        : <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-on-surface-variant" aria-hidden />}
      <span className={available ? 'text-on-surface' : 'text-on-surface-variant'}>
        <strong>{label}</strong>: {available ? 'on' : 'off'}{!available && detail ? ` — ${detail}` : ''}
      </span>
    </p>
  );
}

/** Someone who is not an admin: whether voice works, and who sets it up. */
function MemberVoice() {
  const status = useQuery({ queryKey: ['voice-status'], queryFn: () => api.get<VoiceStatus>('/voice/status') });
  if (status.error) return <InlineError message={`Could not read the voice status: ${errorText(status.error)}`} />;
  if (!status.data) return <Loading />;
  return (
    <div className="bg-surface-container rounded-xl p-4 space-y-2" data-testid="voice-member">
      <StatusLine label="Hear (speech to text)" available={status.data.sttAvailable} detail={status.data.sttReason} />
      <StatusLine label="Speak (text to speech)" available={status.data.ttsAvailable} detail={status.data.ttsReason} />
      <p className="text-sm text-on-surface-variant">An admin sets up voice.</p>
    </div>
  );
}

function AdminVoice() {
  const qc = useQueryClient();
  const { handleSave, saving, saved, error: settingError } = useSettingActions();

  const overview = useQuery({
    queryKey: ['voice-engines'],
    queryFn: () => api.get<SpeechOverview>('/voice/engines'),
    // An install runs on the server: follow it until it ends.
    refetchInterval: (query) => (query.state.data?.jobs.some((job) => job.stage === 'running') ? INSTALL_POLL_MS : false),
  });
  // The voices are the primary Speak engine's: read again when another engine takes its place.
  const speakModel = overview.data?.speak.model ?? null;
  const voices = useQuery({
    queryKey: ['voice-voices', speakModel],
    queryFn: () => api.get<VoicesAnswer>('/voice/voices'),
    enabled: !!overview.data,
  });
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings?: Record<string, SettingItem[]> }>('/settings'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['voice-engines'] });
    void qc.invalidateQueries({ queryKey: ['voice-voices'] });
  };

  if (overview.error) {
    return (
      <div className="space-y-2">
        <InlineError message={`Could not read the speech engines: ${errorText(overview.error)}`} testId="voice-overview-error" />
        <button type="button" className={quietBtn} onClick={() => void overview.refetch()}>Try again</button>
      </div>
    );
  }
  if (!overview.data) return <Loading />;

  const data = overview.data;
  const voiceSettings = settings.data?.settings?.voice ?? [];
  const saver = { save: (key: string, value: unknown) => { void handleSave(key, value); }, saving, saved };
  const speakEngine = data.engines.find((engine) => engine.direction === 'tts' && engine.role === 'primary');

  return (
    <>
      <EnginesSection direction="stt" overview={data} onChanged={refresh} />
      <EnginesSection direction="tts" overview={data} profiles={voices.data?.profiles} onChanged={refresh} />

      {voices.error
        ? <InlineError message={`Could not read the voices: ${errorText(voices.error)}`} testId="voice-voices-error" />
        : voices.data && <VoicesSection voices={voices.data} engine={speakEngine} onChanged={refresh} />}

      {settings.error && <InlineError message={`Could not read the settings: ${errorText(settings.error)}`} />}
      <InlineError message={settingError || null} testId="voice-setting-error" />
      <ConversationSection settings={voiceSettings} saver={saver} />
      <CallsSection settings={voiceSettings} saver={saver} />
    </>
  );
}

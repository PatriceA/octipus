/**
 * One-time move of the retired `voice.*` engine settings onto the
 * Transcription and Speech lanes (docs/VOICE.md → Engines are models).
 *
 * What an install used keeps working: the engine its settings named becomes a
 * model row bound `primary`; the next engine that can run, of the other kind
 * (local ↔ cloud), becomes `backup`. `auto` used to mean different things in
 * different places (the microphone tried the cloud first, voice notes tried
 * whisper.cpp first); it now means **local first** everywhere, since that is
 * private and free — the Topics page shows the result and switches it in a click.
 *
 * Never touches a lane that is already bound, and runs once (a stored marker):
 * a lane an operator unbinds on purpose stays unbound.
 */
import { existsSync } from 'node:fs';
import { getConfig } from '@/config';
import { getSettingsService } from '@/config/settings-service';
import type { ModelConfigEntry, NewModelConfigEntry } from '@/db/schema/models';
import { getModelRegistry } from '@/models/model-registry';
import { logger } from '@/utils/logger';
import { catalogEntry, isLocalSpeechRow, type SpeechDirection, type SpeechEngineEntry, type SpeechEngineKind, speechRowAvailable } from './speech-rows';

const log = logger.child({ component: 'voice-lane-migration' });
/** A settings-table sentinel, like `_system.envMigrated`: it lives in the database in every mode. */
export const VOICE_LANES_MIGRATION_KEY = '_system.voiceLanesMigrated';

/** The retired setting's default: a path the install never chose says nothing. */
const DEFAULT_WHISPER_MODEL_PATH = './models/whisper/ggml-base.bin';

/** A model path the operator set and that is on disk; otherwise the engine's own default. */
function chosenModelPath(path: string | undefined, fallback?: string): Partial<NewModelConfigEntry> | undefined {
  if (!path || path === fallback || !existsSync(path)) return undefined;
  return { metadata: { modelPath: path } };
}

const LANE: Record<SpeechDirection, 'transcription' | 'speech'> = { stt: 'transcription', tts: 'speech' };

function entryRow(entry: SpeechEngineEntry, extra: Partial<NewModelConfigEntry> = {}): NewModelConfigEntry {
  return {
    ...entry.row,
    supportsTools: false,
    supportsStreaming: false,
    supportsVision: false,
    ...extra,
    metadata: { ...(entry.row.metadata ?? {}), ...(extra.metadata ?? {}), capabilitiesDetectedAt: new Date().toISOString() },
  } as NewModelConfigEntry;
}

/** The row for `entry`, created when this install has none of that name. */
async function ensureRow(row: NewModelConfigEntry): Promise<ModelConfigEntry> {
  const registry = getModelRegistry();
  return (await registry.getModel(row.name)) ?? registry.registerModel(row);
}

async function bind(row: ModelConfigEntry, lane: string, role: 'primary' | 'backup'): Promise<void> {
  await getModelRegistry().updateModel(row.name, { topicRoles: { ...(row.topicRoles ?? {}), [lane]: role } });
}

/** The candidates for one direction, in the order the old settings meant. */
function candidatesFor(direction: SpeechDirection): Array<{ entry: SpeechEngineEntry; extra?: Partial<NewModelConfigEntry>; explicit: boolean }> {
  const v = getConfig().voice;
  const whisper = { entry: catalogEntry('whisper', 'stt')!, extra: chosenModelPath(v.whisperModelPath, DEFAULT_WHISPER_MODEL_PATH) };
  const faster = { entry: catalogEntry('fasterwhisper', 'stt', v.fasterWhisperModel || 'small')! };
  const kokoro = { entry: catalogEntry('kokoro', 'tts')! };
  const piper = { entry: catalogEntry('piper', 'tts')!, extra: chosenModelPath(v.piperModelPath) };
  const cloud = (kind: 'mistral' | 'openai') => ({ entry: catalogEntry(kind, direction)! });
  if (direction === 'stt') {
    const chosen = v.sttProvider as string | undefined;
    const byKind: Record<string, { entry: SpeechEngineEntry; extra?: Partial<NewModelConfigEntry> }> = {
      whisper, fasterwhisper: faster, mistral: cloud('mistral'), openai: cloud('openai'),
    };
    // faster-whisper was never part of `auto` (it is chosen by name), so it is
    // not picked for an install that left the choice to Octipus.
    const auto = [whisper, cloud('mistral'), cloud('openai')].map((c) => ({ ...c, explicit: false }));
    if (chosen && chosen !== 'auto' && byKind[chosen]) {
      return [{ ...byKind[chosen], explicit: true }, ...auto.filter((c) => c.entry !== byKind[chosen].entry)];
    }
    return auto;
  }
  const chosen = v.ttsProvider as string | undefined;
  const byKind: Record<string, { entry: SpeechEngineEntry; extra?: Partial<NewModelConfigEntry> }> = {
    kokoro, piper, mistral: cloud('mistral'), openai: cloud('openai'),
  };
  // `mistral` is the setting's default, not necessarily a choice: it leads
  // (it is what the install spoke with) but only when it can run. Nothing
  // else of the cloud stands in for it: the old setting never spoke through OpenAI.
  if (!chosen || chosen === 'mistral') {
    return [cloud('mistral'), kokoro, piper].map((c) => ({ ...c, explicit: false }));
  }
  const auto = [kokoro, piper, cloud('mistral'), cloud('openai')].map((c) => ({ ...c, explicit: false }));
  if (byKind[chosen]) return [{ ...byKind[chosen], explicit: true }, ...auto.filter((c) => c.entry !== byKind[chosen].entry)];
  return auto;
}

async function migrateDirection(direction: SpeechDirection): Promise<string> {
  const registry = getModelRegistry();
  const lane = LANE[direction];
  if (await registry.getModelForTopic(lane)) return `${lane}: already bound, left as is`;
  const candidates = candidatesFor(direction);
  const runnable: Array<{ row: NewModelConfigEntry; local: boolean; explicit: boolean }> = [];
  for (const c of candidates) {
    const row = entryRow(c.entry, c.extra);
    const available = await speechRowAvailable(row as ModelConfigEntry);
    // An engine the operator chose explicitly is kept even when it cannot run
    // right now (a key not entered yet): health says why; the lane says what.
    if (available.ok || c.explicit) runnable.push({ row, local: isLocalSpeechRow(row as ModelConfigEntry), explicit: c.explicit });
  }
  // An explicit choice wins; otherwise the candidates' order (stt: local first; tts: what the install used).
  const primary = runnable.find((r) => r.explicit) ?? (direction === 'stt' ? runnable.find((r) => r.local) : undefined) ?? runnable[0];
  if (!primary) return `${lane}: nothing configured, left unbound`;
  const backup = runnable.find((r) => r !== primary && r.local !== primary.local);
  await bind(await ensureRow(primary.row), lane, 'primary');
  if (backup) await bind(await ensureRow(backup.row), lane, 'backup');
  return `${lane}: ${primary.row.name}${backup ? ` (backup ${backup.row.name})` : ''}`;
}

/** Run once per install; returns what it did, or null when it had run already. */
export async function migrateVoiceSettingsToLanes(): Promise<string[] | null> {
  const settings = getSettingsService();
  if (await settings.get(VOICE_LANES_MIGRATION_KEY)) return null;
  const done = [await migrateDirection('stt'), await migrateDirection('tts')];
  await settings.set(VOICE_LANES_MIGRATION_KEY, new Date().toISOString(), 'system');
  log.info({ result: done }, 'Voice engines moved to the Transcription and Speech lanes');
  return done;
}

/** Which engine kind the old settings named, for a log line. */
export function retiredVoiceSettings(): { stt: SpeechEngineKind | 'auto' | undefined; tts: SpeechEngineKind | undefined } {
  const v = getConfig().voice;
  return { stt: v.sttProvider as SpeechEngineKind | 'auto' | undefined, tts: v.ttsProvider as SpeechEngineKind | undefined };
}

/**
 * One way to get speech done (docs/VOICE.md): every place that transcribes or
 * speaks — channel voice notes, the live microphone, `/voice/transcribe`,
 * `/voice/speak`, voice replies, phone calls, the TUI (through the API), the
 * audio tools — resolves its engine here, from the model bound to the
 * Transcription or Speech lane:
 *
 *   - primary, then backup: a primary that cannot run or fails falls to the
 *     backup, logged with the reason (never silently);
 *   - protection levels: content that must stay local only reaches a local
 *     engine (`assertMayLeave`);
 *   - accounting: every call is recorded against the row (`recordProviderUsage`);
 *   - an account that may not use the install's hosted models gets local engines only.
 *
 * Callers may ask for a particular engine (`override`): a row name, or one of
 * the old engine names (`whisper`, `fasterwhisper`, `mistral`, `openai`,
 * `local`, `whisper-cpp`, `auto`), which pick the bound row of that engine —
 * the mobile app and older web builds still send them.
 */
import { CapabilityNotConfiguredError } from '@/core/capabilities/gates';
import type { ModelConfigEntry } from '@/db/schema/models';
import { getModelRegistry } from '@/models/model-registry';
import { boundTo } from '@/models/media-resolver';
import { logger } from '@/utils/logger';
import {
  engineKindOf, isLocalSpeechRow, type SpeechDirection, speechDirectionOf, type SpeechEngineKind, type SpeechFormat,
  speechFormats, speechRowAvailable, sttEngineFor, ttsEngineFor,
} from './speech-rows';
import type { STTEngine, TranscriptionResult } from './stt';
import type { TTSEngine } from './tts';

const log = logger.child({ component: 'speech-resolve' });

const LANE: Record<SpeechDirection, 'transcription' | 'speech'> = { stt: 'transcription', tts: 'speech' };
const CAPABILITY: Record<SpeechDirection, 'hear' | 'speak'> = { stt: 'hear', tts: 'speak' };

/** Old engine names → engine family. `auto`/`local` mean "whatever is bound" / "a local one". */
const ALIASES: Record<string, SpeechEngineKind | 'auto' | 'local'> = {
  auto: 'auto',
  local: 'local',
  'whisper-cpp': 'whisper',
  whisper: 'whisper',
  fasterwhisper: 'fasterwhisper',
  'faster-whisper': 'fasterwhisper',
  mistral: 'mistral',
  openai: 'openai',
  kokoro: 'kokoro',
  piper: 'piper',
  'whisper-1': 'openai',
};

export interface SpeechRequest {
  sessionId?: string;
  userId?: string;
  /** A row name or an old engine name; unset = the lane's binding. */
  override?: string | null;
  /** False: the caller's account may not spend the install's hosted keys — local engines only. */
  allowHosted?: boolean;
}

/** The lane's primary and backup rows, in that order, that this request may use. */
export async function speechCandidates(direction: SpeechDirection, req: SpeechRequest = {}): Promise<ModelConfigEntry[]> {
  const registry = getModelRegistry();
  const lane = LANE[direction];
  const primary = await registry.getModelForTopic(lane);
  const backup = await registry.getBackupModelForTopic(lane);
  let rows = [primary, backup].filter((r): r is ModelConfigEntry => !!r && boundTo(r, lane));
  rows = rows.filter((r, i) => rows.findIndex((o) => o.name === r.name) === i);
  if (req.override) {
    const alias = ALIASES[req.override] ?? (req.override.startsWith('voxtral') ? 'mistral' : undefined);
    // A cloud engine asked for by an account that may not spend the install's keys.
    if (req.allowHosted === false && (alias === 'mistral' || alias === 'openai')) {
      throw new Error(`${req.override} uses the install's keys, which this account may not use; bind a local engine for it.`);
    }
    if (alias === 'local') rows = rows.filter(isLocalSpeechRow);
    else if (alias && alias !== 'auto') rows = rows.filter((r) => engineKindOf(r) === alias);
    else if (!alias) {
      // A row by name: an install row that is a speech engine of this direction, bound or not.
      const named = await registry.getModel(req.override);
      if (!named || named.ownerUserId || named.isEnabled === false || speechDirectionOf(named) !== direction) {
        throw new Error(`"${req.override}" is not a ${direction === 'stt' ? 'speech-to-text' : 'text-to-speech'} engine on this install.`);
      }
      rows = [named];
    }
    if (rows.length === 0) throw new Error(`No ${req.override} engine is bound to the ${LANE[direction]} lane. Bind one on the Topics page.`);
  }
  if (req.allowHosted === false) rows = rows.filter(isLocalSpeechRow);
  return rows;
}

/**
 * The first candidate that can run now, with why the others could not.
 * Throws `CapabilityNotConfiguredError` when nothing is bound, and an Error
 * naming every reason when something is bound but nothing can run.
 */
export async function pickSpeechRow(direction: SpeechDirection, req: SpeechRequest = {}): Promise<ModelConfigEntry> {
  const rows = await speechCandidates(direction, req);
  if (rows.length === 0) {
    if (req.allowHosted === false) throw new Error('Speech here uses the install\'s keys, which this account may not use; bind a local engine for it.');
    throw new CapabilityNotConfiguredError(CAPABILITY[direction]);
  }
  const reasons: string[] = [];
  for (const row of rows) {
    const available = await speechRowAvailable(row);
    if (!available.ok) { reasons.push(`${row.name}: ${available.reason}`); continue; }
    const refused = await refusalFor(row, req);
    if (refused) { reasons.push(`${row.name}: ${refused}`); continue; }
    if (reasons.length) log.warn({ using: row.name, skipped: reasons }, `Using the ${LANE[direction]} backup`);
    return row;
  }
  throw new Error(`No ${LANE[direction]} engine can run: ${reasons.join('; ')}`);
}

/**
 * Why this row may not take the request's content (a cloud engine for
 * content that stays local), or null. A refusal moves on to the next row —
 * a local backup — instead of failing the whole request.
 */
async function refusalFor(row: ModelConfigEntry, req: SpeechRequest): Promise<string | null> {
  if (isLocalSpeechRow(row)) return null;
  const { assertMayLeave, ProtectionRoutingError } = await import('@/core/protection/routing');
  try {
    await assertMayLeave(row, req.sessionId, row.provider);
    return null;
  } catch (err) {
    if (err instanceof ProtectionRoutingError) return err.message;
    throw err;
  }
}

/** Record one speech call against its row (cost, spend budgets). */
/**
 * What a speech call costs: the row's `pricing.perAudioMinute` (transcription)
 * or `pricing.perMillionChars` (speech), else a list price for the cloud
 * engines; a local engine costs nothing. Undefined when unknown.
 */
export function speechCost(row: ModelConfigEntry, requestType: 'transcription' | 'speech', units: Record<string, number>): number | undefined {
  if (isLocalSpeechRow(row)) return 0;
  const pricing = row.metadata?.pricing;
  if (requestType === 'transcription') {
    const perMinute = pricing?.perAudioMinute ?? (/gpt-4o-mini-transcribe/i.test(row.modelId) ? 0.003 : /whisper-1|gpt-4o-transcribe/i.test(row.modelId) ? 0.006 : /voxtral/i.test(row.modelId) ? 0.001 : undefined);
    return perMinute !== undefined && typeof units.seconds === 'number' ? (perMinute * units.seconds) / 60 : undefined;
  }
  const perMillion = pricing?.perMillionChars ?? (/tts-1-hd/i.test(row.modelId) ? 30 : /tts-1|gpt-4o-mini-tts/i.test(row.modelId) ? 15 : /voxtral.*tts/i.test(row.modelId) ? 16 : undefined);
  return perMillion !== undefined && typeof units.characters === 'number' ? (perMillion * units.characters) / 1_000_000 : undefined;
}

export async function recordSpeechUsage(row: ModelConfigEntry, requestType: 'transcription' | 'speech', req: SpeechRequest, units: Record<string, number>, failed = false): Promise<void> {
  const { recordProviderUsage } = await import('@/models/providers/instrumented');
  const cost = failed ? undefined : speechCost(row, requestType, units);
  await recordProviderUsage(
    { model: row.modelId, modelConfigName: row.name, messages: [], requestType, userId: req.userId, sessionId: req.sessionId, accountingMetadata: units },
    row.provider,
    { model: row.modelId, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false, ...(cost !== undefined ? { reportedCost: cost } : {}) } },
    failed,
  ).catch((err: unknown) => log.warn({ err, model: row.name }, 'Speech usage could not be recorded'));
}

async function language(): Promise<string> {
  const { getConfig } = await import('@/config');
  return getConfig().voice.language || 'en';
}

/** A live speech-to-text engine (the microphone socket, phone calls). The caller disposes it. */
export async function resolveSttEngine(req: SpeechRequest & { streamWindowSeconds?: number } = {}): Promise<{ engine: STTEngine; row: ModelConfigEntry; name: SpeechEngineKind }> {
  const row = await pickSpeechRow('stt', req);
  const engine = await sttEngineFor(row, { language: await language(), streamWindowSeconds: req.streamWindowSeconds });
  return { engine, row, name: engineKindOf(row) as SpeechEngineKind };
}

/** Transcribe a whole clip. Primary, then backup when the primary fails at call time. */
export async function transcribeWithLane(audio: Buffer, req: SpeechRequest & { format?: string; language?: string } = {}): Promise<TranscriptionResult & { model: string }> {
  const rows = await speechCandidates('stt', req);
  if (rows.length === 0) {
    if (req.allowHosted === false) throw new Error('Hosted transcription uses the install\'s keys, which this account may not use; bind a local engine for it.');
    throw new CapabilityNotConfiguredError('hear');
  }
  const lang = req.language || await language();
  const errors: string[] = [];
  for (const row of rows) {
    const available = await speechRowAvailable(row);
    if (!available.ok) { errors.push(`${row.name}: ${available.reason}`); continue; }
    const refused = await refusalFor(row, req);
    if (refused) { errors.push(`${row.name}: ${refused}`); continue; }
    const engine = await sttEngineFor(row, { language: lang });
    try {
      // whisper.cpp reads a WAV it converts itself; the others take the container as is.
      const result = engineKindOf(row) === 'whisper' && 'transcribeBuffer' in engine
        ? await (engine as STTEngine & { transcribeBuffer(b: Buffer): Promise<TranscriptionResult> }).transcribeBuffer(audio)
        : await transcribeAs(engine, audio, req.format);
      await recordSpeechUsage(row, 'transcription', req, { seconds: Math.round(result.duration || 0) });
      if (errors.length) log.warn({ using: row.name, failed: errors }, 'Transcribed with the backup engine');
      return { ...result, model: row.name };
    } catch (err) {
      await recordSpeechUsage(row, 'transcription', req, { seconds: 0 }, true);
      errors.push(`${row.name}: ${(err as Error).message}`);
    } finally {
      await engine.dispose().catch(() => {});
    }
  }
  throw new Error(`Transcription failed: ${errors.join('; ')}`);
}

/**
 * Cloud transcription APIs read the container from the file name, so a clip
 * of a known format goes as `audio.<format>` (a voice note is ogg, not wav).
 */
async function transcribeAs(engine: STTEngine, audio: Buffer, format?: string): Promise<TranscriptionResult> {
  const ext = format?.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!ext) return engine.transcribe(audio);
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'octipus-stt-'));
  const path = join(dir, `audio.${ext}`);
  try {
    await writeFile(path, audio, { mode: 0o600 });
    return await engine.transcribe(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface SpokenAudio {
  audio: Buffer;
  format: SpeechFormat;
  contentType: string;
  model: string;
}

const CONTENT_TYPES: Record<SpeechFormat, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg', ogg: 'audio/ogg', pcm: 'audio/L16', flac: 'audio/flac',
};

/**
 * Speak `text`. `format` is a preference: an engine that writes only another
 * format answers in that one (the result says which), unless `strictFormat`.
 */
export async function synthesizeWithLane(text: string, req: SpeechRequest & { voice?: string; format?: SpeechFormat; strictFormat?: boolean } = {}): Promise<SpokenAudio> {
  const rows = await speechCandidates('tts', req);
  if (rows.length === 0) {
    if (req.allowHosted === false) throw new Error('Speech synthesis here uses the install\'s keys, which this account may not use; bind a local engine for it.');
    throw new CapabilityNotConfiguredError('speak');
  }
  const { getConfig } = await import('@/config');
  const errors: string[] = [];
  for (const [index, row] of rows.entries()) {
    // A voice id belongs to one engine. The caller's voice goes to the engine
    // it asked for (the first tried); `voice.ttsVoice` is the voice of the
    // lane's primary and goes to it alone. Any other engine speaks in its own default.
    const voice = req.voice
      ? (index === 0 ? req.voice : undefined)
      : (row.topicRoles?.speech === 'primary' ? (getConfig().voice.ttsVoice || undefined) : undefined);
    const available = await speechRowAvailable(row);
    if (!available.ok) { errors.push(`${row.name}: ${available.reason}`); continue; }
    const formats = speechFormats(row);
    const format = req.format && formats.includes(req.format) ? req.format : formats[0];
    if (req.strictFormat && req.format && format !== req.format) {
      errors.push(`${row.name}: writes ${formats.join('/')} only, not ${req.format}`);
      continue;
    }
    const refused = await refusalFor(row, req);
    if (refused) { errors.push(`${row.name}: ${refused}`); continue; }
    const engine: TTSEngine = await ttsEngineFor(row, { voice, format });
    try {
      const audio = await engine.synthesize(text);
      await recordSpeechUsage(row, 'speech', req, { characters: text.length });
      if (errors.length) log.warn({ using: row.name, failed: errors }, 'Spoke with the backup engine');
      return { audio, format, contentType: CONTENT_TYPES[format], model: row.name };
    } catch (err) {
      await recordSpeechUsage(row, 'speech', req, { characters: 0 }, true);
      errors.push(`${row.name}: ${(err as Error).message}`);
    } finally {
      await engine.dispose().catch(() => {});
    }
  }
  throw new Error(`Speech synthesis failed: ${errors.join('; ')}`);
}

/** What serves each direction now, for `/voice/status`, the Voice tab and the capability gates. */
export async function speechStatus(direction: SpeechDirection, req: SpeechRequest = {}): Promise<{ available: boolean; model: string | null; engine: SpeechEngineKind | null; local: boolean; reason: string | null }> {
  try {
    const row = await pickSpeechRow(direction, req);
    return { available: true, model: row.name, engine: engineKindOf(row) ?? null, local: isLocalSpeechRow(row), reason: null };
  } catch (err) {
    return { available: false, model: null, engine: null, local: false, reason: (err as Error).message };
  }
}

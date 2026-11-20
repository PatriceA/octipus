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
  speechFormats, speechRowAvailable, speechStaysLocal, type SpeechVoice, sttEngineFor, ttsEngineFor,
} from './speech-rows';
import { speechConfigOf } from './speech-hints';
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
    if (rows.length === 0) throw new Error(`No ${req.override} engine is bound to the ${LANE[direction]} lane. Add one under Settings → Voice.`);
  }
  if (req.allowHosted === false) {
    // Local engines and speech servers on the owner's own network spend no hosted key.
    const local = await Promise.all(rows.map((r) => speechStaysLocal(r)));
    rows = rows.filter((_, i) => local[i]);
  }
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
export async function speechCost(row: ModelConfigEntry, requestType: 'transcription' | 'speech', units: Record<string, number>): Promise<number | undefined> {
  const pricing = row.metadata?.pricing;
  if (isLocalSpeechRow(row) || pricing?.free) return 0;
  const { runsLocally } = await import('@/core/protection/routing');
  if (await runsLocally(row)) return 0;
  if (requestType === 'transcription') {
    const perMinute = pricing?.perAudioMinute ?? (/gpt-4o-mini-transcribe/i.test(row.modelId) ? 0.003 : /whisper-1|gpt-4o-transcribe/i.test(row.modelId) ? 0.006 : /voxtral/i.test(row.modelId) ? 0.001 : undefined);
    return perMinute !== undefined && typeof units.seconds === 'number' ? (perMinute * units.seconds) / 60 : undefined;
  }
  const perMillion = pricing?.perMillionChars ?? (/tts-1-hd/i.test(row.modelId) ? 30 : /tts-1|gpt-4o-mini-tts/i.test(row.modelId) ? 15 : /voxtral.*tts/i.test(row.modelId) ? 16 : undefined);
  return perMillion !== undefined && typeof units.characters === 'number' ? (perMillion * units.characters) / 1_000_000 : undefined;
}

export async function recordSpeechUsage(row: ModelConfigEntry, requestType: 'transcription' | 'speech', req: SpeechRequest, units: Record<string, number>, failed = false): Promise<void> {
  const { recordProviderUsage } = await import('@/models/providers/instrumented');
  const cost = failed ? undefined : await speechCost(row, requestType, units);
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

/** `voice.endpointSilenceMs`, when it is set to something usable. */
async function endpointSilence(): Promise<number | undefined> {
  try {
    const { getSettingsService } = await import('@/config/settings-service');
    const value = Number(await getSettingsService().get('voice.endpointSilenceMs'));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A live speech-to-text engine (the microphone socket, phone calls). The
 * caller disposes it. `endpointSilenceMs` is the pause that ends the caller's
 * turn (default: `voice.endpointSilenceMs`): an engine that ends utterances
 * on its own server (NeMo) is told to end them sooner than that.
 */
export async function resolveSttEngine(req: SpeechRequest & { streamWindowSeconds?: number; endpointSilenceMs?: number } = {}): Promise<{ engine: STTEngine; row: ModelConfigEntry; name: SpeechEngineKind }> {
  const row = await pickSpeechRow('stt', req);
  const engine = await sttEngineFor(row, {
    language: await language(), streamWindowSeconds: req.streamWindowSeconds, endpointSilenceMs: req.endpointSilenceMs ?? await endpointSilence(),
  });
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
      // Billed by the clip's length, never by how long the call took (the
      // engines' `duration` is processing time); unknown stays unknown.
      const seconds = isLocalSpeechRow(row) ? (result.duration || 0) : await (await import('./ffmpeg')).probeBufferSeconds(audio, req.format);
      await recordSpeechUsage(row, 'transcription', req, seconds !== null ? { seconds: Math.round(seconds) } : {});
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

/** Headerless PCM says nothing of itself: its rate (and channels) go in the type, or it plays at the wrong speed. */
function contentTypeOf(format: SpeechFormat, row: ModelConfigEntry, engine: TTSEngine): string {
  if (format !== 'pcm') return CONTENT_TYPES[format];
  const rate = engine.pcmSampleRate ?? speechConfigOf(row).sampleRate ?? 24000;
  return `audio/L16;rate=${rate};channels=1`;
}

/** How a request wants to be spoken. */
export interface SpeakOptions {
  /** A voice profile by name, or a voice the engine offers (a preset id). */
  voice?: string;
  /** A voice profile by name (wins over `voice`). */
  profile?: string;
  /** How the voice should sound or the line be delivered, on top of the profile. */
  instructions?: string;
  speed?: number;
}

/**
 * The voice `row` speaks this request in. A voice belongs to an engine, so:
 * a profile named by the request, then a preset id named by the request (for
 * the engine it asked for — the first tried), then the active profile, then
 * the old `voice.ttsVoice` for the lane's primary. A profile made for another
 * engine is not handed to this one: it speaks in its own default.
 */
async function voiceForRow(row: ModelConfigEntry, index: number, req: SpeakOptions): Promise<SpeechVoice> {
  const { activeVoiceProfileName, getVoiceProfile, profileVoiceFor } = await import('./profiles');
  const overrides = (voice: SpeechVoice): SpeechVoice => ({
    ...voice,
    ...(req.instructions ? { instructions: voice.instructions ? `${voice.instructions}. ${req.instructions}` : req.instructions } : {}),
    ...(req.speed ? { speed: req.speed } : {}),
  });
  const named = req.profile ?? req.voice;
  if (named) {
    const profile = await getVoiceProfile(named);
    if (req.profile && !profile) throw new Error(`No voice profile named "${req.profile}".`);
    if (profile) return overrides((await profileVoiceFor(profile, row)) ?? {});
    return overrides(index === 0 ? { voice: req.voice } : {});
  }
  const active = await activeVoiceProfileName();
  if (active) {
    const profile = await getVoiceProfile(active);
    const voice = profile ? await profileVoiceFor(profile, row) : undefined;
    if (voice) return overrides(voice);
  }
  const { getConfig } = await import('@/config');
  const legacy = row.topicRoles?.speech === 'primary' ? (getConfig().voice.ttsVoice || undefined) : undefined;
  return overrides(legacy ? { voice: legacy } : {});
}

/**
 * Speak `text`. `format` is a preference: an engine that writes only another
 * format answers in that one (the result says which), unless `strictFormat`.
 */
export async function synthesizeWithLane(text: string, req: SpeechRequest & SpeakOptions & { format?: SpeechFormat; strictFormat?: boolean } = {}): Promise<SpokenAudio> {
  const rows = await speechCandidates('tts', req);
  if (rows.length === 0) {
    if (req.allowHosted === false) throw new Error('Speech synthesis here uses the install\'s keys, which this account may not use; bind a local engine for it.');
    throw new CapabilityNotConfiguredError('speak');
  }
  const errors: string[] = [];
  for (const [index, row] of rows.entries()) {
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
    let engine: TTSEngine | null = null;
    try {
      engine = await ttsEngineFor(row, { ...(await voiceForRow(row, index, req)), format });
      const audio = await engine.synthesize(text);
      await recordSpeechUsage(row, 'speech', req, { characters: text.length });
      if (errors.length) log.warn({ using: row.name, failed: errors }, 'Spoke with the backup engine');
      return { audio, format, contentType: contentTypeOf(format, row, engine), model: row.name };
    } catch (err) {
      await recordSpeechUsage(row, 'speech', req, { characters: 0 }, true);
      errors.push(`${row.name}: ${(err as Error).message}`);
    } finally {
      await engine?.dispose().catch(() => {});
    }
  }
  throw new Error(`Speech synthesis failed: ${errors.join('; ')}`);
}

/**
 * PCM as it is generated. `return()` always releases the engine and stops the
 * request behind it — also for a stream nobody started reading (a sentence
 * synthesised ahead and then dropped by an interruption), which a plain async
 * generator would leave open.
 */
export interface SpeechChunks extends AsyncIterableIterator<Buffer> {
  return(value?: unknown): Promise<IteratorResult<Buffer>>;
}

export interface SpeechStream {
  /** The model row that speaks. */
  model: string;
  sampleRate: number;
  /** Mono s16le PCM, as it is generated. */
  chunks: SpeechChunks;
}

/**
 * Speak `text` as PCM that can be played while the rest is still being
 * generated — what a live conversation and a phone line play. An engine that
 * streams is read as it generates; any other writes a WAV, whose samples are
 * handed over in one piece. Primary, then backup: an engine that fails before
 * its first audio is skipped (with the reason), after it the stream fails.
 */
export async function streamSpeechWithLane(text: string, req: SpeechRequest & SpeakOptions = {}): Promise<SpeechStream> {
  const rows = await speechCandidates('tts', req);
  if (rows.length === 0) {
    if (req.allowHosted === false) throw new Error('Speech synthesis here uses the install\'s keys, which this account may not use; bind a local engine for it.');
    throw new CapabilityNotConfiguredError('speak');
  }
  const errors: string[] = [];
  for (const [index, row] of rows.entries()) {
    const available = await speechRowAvailable(row);
    if (!available.ok) { errors.push(`${row.name}: ${available.reason}`); continue; }
    const refused = await refusalFor(row, req);
    if (refused) { errors.push(`${row.name}: ${refused}`); continue; }
    let engine: TTSEngine | null = null;
    try {
      const formats = speechFormats(row);
      engine = await ttsEngineFor(row, { ...(await voiceForRow(row, index, req)), format: formats.includes('wav') ? 'wav' : formats[0] });
      let sampleRate: number;
      let source: AsyncGenerator<Buffer>;
      if (engine.streamPcm && engine.pcmSampleRate) {
        sampleRate = engine.pcmSampleRate;
        source = engine.streamPcm(text);
      } else {
        if (!formats.includes('wav')) throw new Error(`writes ${formats.join('/')} only; a live voice needs WAV or a PCM stream`);
        const { parseWav } = await import('./wav');
        const wav = parseWav(await engine.synthesize(text));
        sampleRate = wav.sampleRate;
        source = (async function* () { yield wav.pcm; })();
      }
      // The first audio decides: a failure before it falls to the backup.
      const first = await source.next();
      if (errors.length) log.warn({ using: row.name, failed: errors }, 'Speaking with the backup engine');
      const held = engine;
      engine = null;
      let pendingFirst: IteratorResult<Buffer> | null = first;
      let finished = false;
      const finish = async (failed: boolean): Promise<void> => {
        if (finished) return;
        finished = true;
        await source.return(undefined).catch(() => {});
        await recordSpeechUsage(row, 'speech', req, { characters: failed ? 0 : text.length }, failed);
        await held.dispose().catch(() => {});
      };
      const chunks: SpeechChunks = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (finished) return { done: true, value: undefined };
          try {
            const result = pendingFirst ?? await source.next();
            pendingFirst = null;
            if (result.done) await finish(false);
            return result;
          } catch (err) {
            await finish(true);
            throw err;
          }
        },
        async return() {
          await finish(false);
          return { done: true, value: undefined };
        },
      };
      return { model: row.name, sampleRate, chunks };
    } catch (err) {
      await recordSpeechUsage(row, 'speech', req, { characters: 0 }, true);
      errors.push(`${row.name}: ${(err as Error).message}`);
    } finally {
      await engine?.dispose().catch(() => {});
    }
  }
  throw new Error(`Speech synthesis failed: ${errors.join('; ')}`);
}

/**
 * Load the Transcription lane's model ahead of use, when it is a local engine
 * that loads on first use (faster-whisper, whisper.cpp): a quarter second of
 * silence through it. Cloud engines and speech servers are left alone — a
 * request there costs money or loads someone else's server for nothing.
 * Nothing is recorded: no one spoke.
 */
export async function warmSpeechEngines(req: SpeechRequest = {}): Promise<void> {
  const row = await pickSpeechRow('stt', req).catch(() => null);
  if (!row || !isLocalSpeechRow(row)) return;
  const { pcm16kMonoToWav } = await import('./stt');
  const engine = await sttEngineFor(row, { language: await language() });
  try {
    await engine.transcribe(pcm16kMonoToWav(new Uint8Array(8000)));
  } finally {
    await engine.dispose().catch(() => {});
  }
}

/** The voices the engine bound to the Speech lane offers (its primary, or the named row). */
export async function speechVoices(req: SpeechRequest = {}): Promise<{ model: string; voices: string[] }> {
  const row = await pickSpeechRow('tts', req);
  const engine = await ttsEngineFor(row, { format: speechFormats(row)[0] });
  try {
    return { model: row.name, voices: await engine.getVoices() };
  } finally {
    await engine.dispose().catch(() => {});
  }
}

/** What serves each direction now, for `/voice/status`, the Voice tab and the capability gates. */
export async function speechStatus(direction: SpeechDirection, req: SpeechRequest = {}): Promise<{ available: boolean; model: string | null; engine: SpeechEngineKind | null; local: boolean; reason: string | null }> {
  try {
    const row = await pickSpeechRow(direction, req);
    return { available: true, model: row.name, engine: engineKindOf(row) ?? null, local: await speechStaysLocal(row), reason: null };
  } catch (err) {
    return { available: false, model: null, engine: null, local: false, reason: (err as Error).message };
  }
}

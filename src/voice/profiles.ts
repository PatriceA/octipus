/**
 * Voice profiles (docs/VOICE.md → Voices): a named way of speaking that
 * outlives the engine it was first made with. A profile is one or more of
 *
 *   - a voice the engine offers (a preset id such as `af_sarah` or `alloy`),
 *   - a description of the voice in words ("a calm woman in her forties,
 *     slight Scottish accent") for engines that design a voice from text,
 *   - a reference clip, with what is said in it, for engines that clone.
 *
 * The active profile (`voice.profile`) is what replies, voice notes and phone
 * calls are spoken in; the `speak` tool and `/api/voice/speak` may name any
 * other. A profile made for one engine is given to that engine only: a preset
 * id means nothing to another. Profiles live in the `voice.profiles` setting;
 * reference clips are WAV files under `~/.octipus/voices`.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelConfigEntry } from '@/db/schema/models';
import { logger } from '@/utils/logger';
import type { SpeechVoice } from './speech-rows';

const log = logger.child({ component: 'voice-profiles' });

export interface VoiceProfile {
  name: string;
  /** A note for whoever picks it. */
  description?: string;
  /** A voice the engine offers. */
  voice?: string;
  /** The voice in words. */
  instructions?: string;
  /** The reference clip's file name under the voices directory. */
  refAudio?: string;
  refAudioType?: string;
  /** What is said in the reference clip. */
  refText?: string;
  speed?: number;
  /** The model row this profile was made for; unset = any engine. */
  model?: string;
}

const MAX_CLIP_BYTES = 10 * 1024 * 1024;
/** Enough for any engine to copy a voice from; a longer clip is cut to this. */
const MAX_CLIP_SECONDS = 20;
/** What a stored clip is: mono 16-bit WAV at this rate. */
const CLIP_RATE = 24000;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
/** A clip's file name is generated here (a UUID and an extension); never a path from a request. */
const CLIP_FILE = /^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;

export function voicesDir(): string {
  return process.env.OCTIPUS_VOICES_DIR || join(homedir(), '.octipus', 'voices');
}

async function settings() {
  return (await import('@/config/settings-service')).getSettingsService();
}

function asProfiles(value: unknown): VoiceProfile[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is VoiceProfile => !!p && typeof p === 'object' && typeof (p as VoiceProfile).name === 'string');
}

export async function listVoiceProfiles(): Promise<VoiceProfile[]> {
  return asProfiles(await (await settings()).get('voice.profiles'));
}

export async function getVoiceProfile(name: string): Promise<VoiceProfile | undefined> {
  const wanted = name.trim().toLowerCase();
  return (await listVoiceProfiles()).find((p) => p.name.toLowerCase() === wanted);
}

export async function activeVoiceProfileName(): Promise<string> {
  const value = await (await settings()).get('voice.profile');
  return typeof value === 'string' ? value : '';
}

export async function setActiveVoiceProfile(name: string, userId?: string): Promise<void> {
  if (name && !(await getVoiceProfile(name))) throw new Error(`No voice profile named "${name}".`);
  await (await settings()).set('voice.profile', name, userId);
}

function isWav(data: Buffer): boolean {
  return data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WAVE';
}

/**
 * A reference clip as every speech server can read it: mono 16-bit WAV, at
 * most 20 seconds. A browser records WebM or Ogg, which the servers that read
 * clips with soundfile / librosa (vLLM-Omni, VoxCPM2, Breeze) cannot open.
 * ffmpeg converts anything; without it a WAV is still taken (downmixed and
 * cut here) and anything else is refused, saying ffmpeg is what is missing.
 */
export async function normalizeClip(data: Buffer, mimeType: string): Promise<Buffer> {
  const { whichSync } = await import('@/utils/proc');
  if (whichSync('ffmpeg')) return transcodeClip(data, mimeType);
  if (!isWav(data)) {
    throw new Error(`A reference clip is converted to WAV with ffmpeg, which is not installed on the server. Install ffmpeg, or upload a WAV file (this one is ${mimeType.split(';')[0]}).`);
  }
  const { parseWav, pcmToWav } = await import('./wav');
  let audio: ReturnType<typeof parseWav>;
  try {
    audio = parseWav(data);
  } catch (err) {
    throw new Error(`The reference clip could not be read: ${(err as Error).message}`);
  }
  return pcmToWav(audio.pcm.subarray(0, MAX_CLIP_SECONDS * audio.sampleRate * 2), audio.sampleRate);
}

async function transcodeClip(data: Buffer, mimeType: string): Promise<Buffer> {
  const [{ runFfmpegTool, safeInput }, { audioExtensionFor }] = await Promise.all([import('./ffmpeg'), import('./speech-rows')]);
  const dir = await mkdtemp(join(tmpdir(), 'octipus-clip-'));
  try {
    const source = join(dir, `in.${audioExtensionFor(mimeType, 'bin')}`);
    const out = join(dir, 'clip.wav');
    await writeFile(source, data, { mode: 0o600 });
    await runFfmpegTool('ffmpeg', [
      '-y', ...safeInput(source), '-t', String(MAX_CLIP_SECONDS), '-map_metadata', '-1',
      '-ac', '1', '-ar', String(CLIP_RATE), '-c:a', 'pcm_s16le', '-f', 'wav', out,
    ], 60_000);
    return await readFile(out);
  } catch (err) {
    throw new Error(`The reference clip could not be converted to WAV: ${(err as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface VoiceProfileInput extends Omit<VoiceProfile, 'refAudio' | 'refAudioType'> {
  /** A new reference clip; unset keeps the stored one, `null` removes it. */
  clip?: { data: Buffer; mimeType: string } | null;
}

/**
 * Create a profile or replace the one of that name. A new clip is stored as
 * WAV (`normalizeClip`). The clip it replaces (or `clip: null` removes) is
 * deleted only once the profile is saved; a save that fails removes the new
 * file instead, so a profile never names a clip that is gone.
 */
export async function saveVoiceProfile(input: VoiceProfileInput, userId?: string): Promise<VoiceProfile> {
  const name = input.name.trim();
  if (!NAME.test(name)) throw new Error('A voice profile name is 1–60 letters, digits, spaces, dots, dashes or underscores.');
  if (input.speed !== undefined && (!Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2)) throw new Error('Speed is between 0.5 and 2.');
  if (input.clip) {
    if (!input.clip.mimeType.startsWith('audio/')) throw new Error('A reference clip must be an audio file.');
    if (input.clip.data.length === 0 || input.clip.data.length > MAX_CLIP_BYTES) throw new Error('A reference clip is at most 10 MB (5–30 seconds of clear speech is enough).');
  }
  const text = (v: string | undefined, max: number) => (v?.trim() ? v.trim().slice(0, max) : undefined);
  const previous = await getVoiceProfile(name);
  const keepsClip = input.clip === undefined && !!previous?.refAudio;
  const profile: VoiceProfile = {
    name,
    description: text(input.description, 300),
    voice: text(input.voice, 200),
    instructions: text(input.instructions, 1000),
    refAudio: keepsClip ? previous?.refAudio : undefined,
    refAudioType: keepsClip ? previous?.refAudioType : undefined,
    refText: keepsClip || input.clip ? text(input.refText, 2000) : undefined,
    speed: input.speed,
    model: text(input.model, 200),
  };
  if (!profile.voice && !profile.instructions && !keepsClip && !input.clip) throw new Error('A voice profile needs a voice, a description or a reference clip.');

  let written: string | undefined;
  if (input.clip) {
    const wav = await normalizeClip(input.clip.data, input.clip.mimeType);
    await mkdir(voicesDir(), { recursive: true });
    written = `${crypto.randomUUID()}.wav`;
    await writeFile(join(voicesDir(), written), wav, { mode: 0o600 });
    profile.refAudio = written;
    profile.refAudioType = 'audio/wav';
  }
  for (const key of Object.keys(profile) as Array<keyof VoiceProfile>) if (profile[key] === undefined) delete profile[key];
  try {
    await (await settings()).update('voice.profiles', (current) => [
      ...asProfiles(current).filter((p) => p.name.toLowerCase() !== name.toLowerCase()), profile,
    ], userId);
  } catch (err) {
    if (written) await rm(join(voicesDir(), written), { force: true });
    throw err;
  }
  const replaced = previous?.refAudio;
  if (replaced && replaced !== profile.refAudio && CLIP_FILE.test(replaced)) await rm(join(voicesDir(), replaced), { force: true });
  return profile;
}

export async function deleteVoiceProfile(name: string, userId?: string): Promise<boolean> {
  const profile = await getVoiceProfile(name);
  if (!profile) return false;
  await (await settings()).update('voice.profiles', (current) => asProfiles(current).filter((p) => p.name !== profile.name), userId);
  if (profile.refAudio && CLIP_FILE.test(profile.refAudio)) await rm(join(voicesDir(), profile.refAudio), { force: true });
  if ((await activeVoiceProfileName()).toLowerCase() === profile.name.toLowerCase()) await (await settings()).set('voice.profile', '', userId);
  return true;
}

/**
 * Clips read from disk, by file and modification time: a live reply speaks
 * sentence by sentence, each with the clip, and handing over the same Buffer
 * each time lets its base64 be encoded once (tts.ts `clipBase64`).
 */
const clipCache = new Map<string, { mtimeMs: number; clip: { data: Buffer; mimeType: string } }>();
const CLIP_CACHE_SIZE = 16;
const missingClips = new Set<string>();

/**
 * The reference clip of a profile, for the engine or for someone listening
 * to it. A clip file that is gone (removed by hand, a restore without the
 * voices directory) is no clip — logged once — rather than failing every
 * spoken reply. A clip stored before clips were kept as WAV is converted here.
 */
export async function voiceProfileClip(profile: VoiceProfile): Promise<{ data: Buffer; mimeType: string } | undefined> {
  if (!profile.refAudio) return undefined;
  if (!CLIP_FILE.test(profile.refAudio)) throw new Error(`Voice profile "${profile.name}" names an invalid clip.`);
  const path = join(voicesDir(), profile.refAudio);
  let mtimeMs: number;
  let data: Buffer;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
    const cached = clipCache.get(path);
    if (cached?.mtimeMs === mtimeMs) return cached.clip;
    data = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    clipCache.delete(path);
    if (!missingClips.has(path)) {
      missingClips.add(path);
      log.warn({ profile: profile.name, file: path }, 'The reference clip of a voice profile is missing; speaking without it');
    }
    return undefined;
  }
  missingClips.delete(path);
  let clip = { data, mimeType: profile.refAudioType || 'audio/wav' };
  if (!isWav(data)) {
    try {
      clip = { data: await normalizeClip(data, clip.mimeType), mimeType: 'audio/wav' };
    } catch (err) {
      log.warn({ err, profile: profile.name }, 'An older reference clip could not be converted to WAV; sending it as it is');
    }
  }
  clipCache.set(path, { mtimeMs, clip });
  if (clipCache.size > CLIP_CACHE_SIZE) clipCache.delete(clipCache.keys().next().value!);
  return clip;
}

/** What a profile asks of `row`, or undefined when it was made for another engine. */
export async function profileVoiceFor(profile: VoiceProfile, row: Pick<ModelConfigEntry, 'name'>): Promise<SpeechVoice | undefined> {
  if (profile.model && profile.model !== row.name) return undefined;
  return {
    voice: profile.voice,
    instructions: profile.instructions,
    refAudio: await voiceProfileClip(profile),
    refText: profile.refText,
    speed: profile.speed,
  };
}

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
 * reference clips are files under `~/.octipus/voices`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelConfigEntry } from '@/db/schema/models';
import type { SpeechVoice } from './speech-rows';

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
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;

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

export interface VoiceProfileInput extends Omit<VoiceProfile, 'refAudio' | 'refAudioType'> {
  /** A new reference clip; unset keeps the stored one, `null` removes it. */
  clip?: { data: Buffer; mimeType: string } | null;
}

/** Create a profile or replace the one of that name. */
export async function saveVoiceProfile(input: VoiceProfileInput, userId?: string): Promise<VoiceProfile> {
  const name = input.name.trim();
  if (!NAME.test(name)) throw new Error('A voice profile name is 1–60 letters, digits, spaces, dots, dashes or underscores.');
  if (input.speed !== undefined && (!Number.isFinite(input.speed) || input.speed < 0.5 || input.speed > 2)) throw new Error('Speed is between 0.5 and 2.');
  const previous = await getVoiceProfile(name);
  let refAudio = previous?.refAudio;
  let refAudioType = previous?.refAudioType;
  if (input.clip === null) {
    if (refAudio) await rm(join(voicesDir(), refAudio), { force: true });
    refAudio = undefined;
    refAudioType = undefined;
  } else if (input.clip) {
    if (!input.clip.mimeType.startsWith('audio/')) throw new Error('A reference clip must be an audio file.');
    if (input.clip.data.length === 0 || input.clip.data.length > MAX_CLIP_BYTES) throw new Error('A reference clip is at most 10 MB (5–30 seconds of clear speech is enough).');
    const { audioExtensionFor } = await import('./speech-rows');
    await mkdir(voicesDir(), { recursive: true });
    const file = `${crypto.randomUUID()}.${audioExtensionFor(input.clip.mimeType, 'wav')}`;
    await writeFile(join(voicesDir(), file), input.clip.data, { mode: 0o600 });
    if (refAudio) await rm(join(voicesDir(), refAudio), { force: true });
    refAudio = file;
    refAudioType = input.clip.mimeType;
  }
  const text = (v: string | undefined, max: number) => (v?.trim() ? v.trim().slice(0, max) : undefined);
  const profile: VoiceProfile = {
    name,
    description: text(input.description, 300),
    voice: text(input.voice, 200),
    instructions: text(input.instructions, 1000),
    refAudio,
    refAudioType,
    refText: refAudio ? text(input.refText, 2000) : undefined,
    speed: input.speed,
    model: text(input.model, 200),
  };
  if (!profile.voice && !profile.instructions && !profile.refAudio) throw new Error('A voice profile needs a voice, a description or a reference clip.');
  for (const key of Object.keys(profile) as Array<keyof VoiceProfile>) if (profile[key] === undefined) delete profile[key];
  await (await settings()).update('voice.profiles', (current) => [
    ...asProfiles(current).filter((p) => p.name.toLowerCase() !== name.toLowerCase()), profile,
  ], userId);
  return profile;
}

export async function deleteVoiceProfile(name: string, userId?: string): Promise<boolean> {
  const profile = await getVoiceProfile(name);
  if (!profile) return false;
  await (await settings()).update('voice.profiles', (current) => asProfiles(current).filter((p) => p.name !== profile.name), userId);
  if (profile.refAudio) await rm(join(voicesDir(), profile.refAudio), { force: true });
  if ((await activeVoiceProfileName()).toLowerCase() === profile.name.toLowerCase()) await (await settings()).set('voice.profile', '', userId);
  return true;
}

/** The reference clip of a profile, for the engine or for someone listening to it. */
export async function voiceProfileClip(profile: VoiceProfile): Promise<{ data: Buffer; mimeType: string } | undefined> {
  if (!profile.refAudio) return undefined;
  // The name was generated here (a UUID and an extension); never a path from a request.
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(profile.refAudio)) throw new Error(`Voice profile "${profile.name}" names an invalid clip.`);
  return { data: await readFile(join(voicesDir(), profile.refAudio)), mimeType: profile.refAudioType || 'audio/wav' };
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

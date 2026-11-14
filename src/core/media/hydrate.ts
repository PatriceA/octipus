/**
 * A request's copy of the conversation with its media loaded (docs/MEDIA.md).
 *
 * Messages carry media as references (`AgentMessage.media`); bytes are read
 * here, for the request being sent, and never stored. Because every image in
 * the history is re-sent with every request, only the newest
 * `replayRecentImages` media-bearing messages keep their pixels; an older one
 * becomes a line naming the file, so the model can look again with
 * `vision__view_image` when it needs to. Media the model cannot take (an
 * image for a model that does not read images — the session switched models)
 * becomes such a line too. A file that has gone is said so, never silently dropped.
 */
import { readFile } from 'node:fs/promises';
import type { AgentMessage, MediaRef } from '@/core/types';
import type { WorkspaceFS } from '@/security/workspace-fs';
import { sniffImageType } from './normalize';

export interface HydrateOptions {
  /** The model reads images (its row's `supportsVision`). */
  readsImages: boolean;
  /** The model takes audio as input (its row's `supportsAudioInput`). */
  hearsAudio: boolean;
  /** How many of the newest media-bearing messages keep their bytes. */
  replayRecent?: number;
  /**
   * The agent's workspace. Only media inside its `.octipus/media` or
   * `.octipus/attachments` is ever read (a reference names a path; a path
   * from anywhere else — a tampered snapshot — is refused, not read).
   */
  fs: WorkspaceFS | null;
  /** The conversation holds content that may not reach this (remote) model as it is. */
  protectedContent?: boolean;
}

const MEDIA_DIRS = ['/.octipus/media/', '/.octipus/attachments/'];

/** The bytes of `ref` when it is a media file of this workspace, of the kind it claims; else null. */
async function readMedia(ref: MediaRef, fs: WorkspaceFS | null): Promise<Buffer | null> {
  if (!fs) return null;
  let path: string;
  try { path = fs.resolve(ref.path); } catch { return null; }
  const normalized = path.split('\\').join('/');
  if (!MEDIA_DIRS.some((dir) => normalized.includes(dir))) return null;
  const bytes = await readFile(path);
  if (ref.kind === 'image') return sniffImageType(bytes) ? bytes : null;
  const head = bytes.subarray(0, 4).toString('latin1');
  const audio = head === 'RIFF' || head.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  return audio ? bytes : null;
}

export const DEFAULT_REPLAY_RECENT_IMAGES = 3;

function note(ref: MediaRef, why: 'older' | 'unsupported' | 'missing' | 'protected'): string {
  const what = ref.kind === 'image' ? 'Image' : 'Audio';
  if (why === 'missing') return `[${what} ${ref.path} is no longer available.]`;
  if (why === 'protected') {
    return ref.kind === 'image'
      ? `[Image ${ref.path} is confidential and this model is not local: call vision__view_image to have a local model describe it.]`
      : `[Audio ${ref.path} is confidential and this model is not local; its transcript is in the conversation.]`;
  }
  if (why === 'unsupported') {
    return ref.kind === 'image'
      ? `[Image ${ref.path} is attached, but this model cannot see images: call vision__view_image to have it described.]`
      : `[Audio ${ref.path} is attached; this model takes no audio: call audio__transcribe_audio for its text.]`;
  }
  return ref.kind === 'image'
    ? `[Image ${ref.path} was shown earlier; call vision__view_image to look at it again.]`
    : `[Audio ${ref.path} was attached earlier; call audio__transcribe_audio for its text.]`;
}

function withNotes(msg: AgentMessage, notes: string[], keep: MediaRef[]): AgentMessage {
  const content = notes.length ? `${msg.content ? `${msg.content}\n` : ''}${notes.join('\n')}` : msg.content;
  const { media: _media, ...rest } = msg;
  return keep.length ? { ...rest, content, media: keep } : { ...rest, content };
}

/** True when any message carries media (the fast path skips everything else). */
export function hasMedia(messages: readonly AgentMessage[]): boolean {
  return messages.some((m) => m.media?.length);
}

export async function hydrateMedia(messages: AgentMessage[], opts: HydrateOptions): Promise<AgentMessage[]> {
  if (!hasMedia(messages)) return messages;
  const replay = Math.max(0, opts.replayRecent ?? DEFAULT_REPLAY_RECENT_IMAGES);
  const out = [...messages];
  let kept = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i];
    if (!msg.media?.length) continue;
    const recent = kept < replay;
    const keep: MediaRef[] = [];
    const notes: string[] = [];
    for (const ref of msg.media) {
      const supported = ref.kind === 'image' ? opts.readsImages : opts.hearsAudio;
      if (!supported) { notes.push(note(ref, 'unsupported')); continue; }
      if (opts.protectedContent) { notes.push(note(ref, 'protected')); continue; }
      if (!recent) { notes.push(note(ref, 'older')); continue; }
      try {
        const bytes = await readMedia(ref, opts.fs);
        if (bytes) keep.push({ ...ref, data: bytes.toString('base64') });
        else notes.push(note(ref, 'missing'));
      } catch {
        notes.push(note(ref, 'missing'));
      }
    }
    if (keep.length) kept++;
    out[i] = withNotes(msg, notes, keep);
  }
  return out;
}

/** Media refs as stored (no bytes): what persistence and compaction see. */
export function withoutMediaBytes(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) => (m.media?.some((r) => r.data) ? { ...m, media: m.media.map(({ data: _data, ...ref }) => ref) } : m));
}

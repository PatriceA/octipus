/**
 * Media a turn made for the person — an image `generate_image` drew, speech
 * `speak` made (src/core/media/turn-media.ts) — as the chat shows it under
 * the answer.
 *
 * It reaches the chat two ways, normalised here to one shape so a live reply
 * and its persisted copy compare equal (chat reconciliation swaps one for the
 * other without a re-render):
 *  - live: `TurnResult.media` on the `chat.response` event (and the REST
 *    `/chat` fallback);
 *  - history: the answer row's `metadata.attachments`, the entries whose
 *    `source` is `assistant` (user uploads and tool images stay out).
 *
 * No `@/` imports: the web specs import this file directly.
 */

export interface TurnMedia {
  kind: 'image' | 'audio';
  /** Absolute path in the session's workspace; read through the session files API. */
  path: string;
  mimeType: string;
  /** `voice`: the spoken reply; `attach`: a file. */
  deliver: 'attach' | 'voice';
  filename?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toMedia(kind: unknown, entry: Record<string, unknown>): TurnMedia | null {
  if (kind !== 'image' && kind !== 'audio') return null;
  if (typeof entry.path !== 'string' || !entry.path) return null;
  const mimeType = typeof entry.mimeType === 'string' && entry.mimeType ? entry.mimeType : kind === 'image' ? 'image/png' : 'audio/mpeg';
  return {
    kind,
    path: entry.path,
    mimeType,
    deliver: entry.deliver === 'voice' ? 'voice' : 'attach',
    ...(typeof entry.filename === 'string' && entry.filename && { filename: entry.filename }),
  };
}

function nonEmpty(items: TurnMedia[]): TurnMedia[] | undefined {
  return items.length ? items : undefined;
}

/** The answer's own media from a stored row's `metadata.attachments`; undefined when there is none. */
export function mediaFromAttachments(attachments: unknown): TurnMedia[] | undefined {
  if (!Array.isArray(attachments)) return undefined;
  return nonEmpty(attachments.flatMap((raw) => {
    const entry = record(raw);
    if (!entry || entry.source !== 'assistant') return [];
    const media = toMedia(entry.type, entry);
    return media ? [media] : [];
  }));
}

/** The media of a live turn result (`TurnResult.media`); undefined when there is none. */
export function mediaFromResult(media: unknown): TurnMedia[] | undefined {
  if (!Array.isArray(media)) return undefined;
  return nonEmpty(media.flatMap((raw) => {
    const entry = record(raw);
    const item = entry && toMedia(entry.kind, entry);
    return item ? [item] : [];
  }));
}

/** The name a download is saved under: the stored filename, else the path's last segment. */
export function mediaFileName(media: TurnMedia): string {
  return media.filename || media.path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || (media.kind === 'image' ? 'image' : 'audio');
}

/** The session files API path that reads `path` (relative to the API base, as `api.get` takes it). */
export function sessionFileApiPath(sessionId: string, path: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}`;
}

/**
 * The bytes of a base64 `data:` URL (what the session files API returns for
 * an image) as a Blob, so the chat can hand the browser a short object URL
 * instead of megabytes of base64 in the DOM. Null for anything else.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]*)(?:;[^;,]*)*;base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] || 'application/octet-stream' });
}

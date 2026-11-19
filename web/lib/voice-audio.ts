/**
 * Recording a clip in the browser and handing it to the voice routes: the
 * composer's dictation, and the Voice page's tests and voice cloning.
 */

/** Base64 of a blob's bytes (what `POST /voice/transcribe` and a profile's `clip` take). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // In pieces: one String.fromCharCode call per byte is slow, one for the whole clip overflows the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** The file extension the server knows a recording's container by (`audio/webm;codecs=opus` → `webm`). */
export function audioFormatOf(mimeType: string): string {
  const sub = (mimeType.split('/')[1] ?? '').split(';')[0].trim().toLowerCase();
  if (sub === 'mp4') return 'm4a';
  return sub || 'webm';
}

export interface ClipRecorder {
  /** The live microphone, for a level display. */
  stream: MediaStream;
  /** Stop recording; `done` then resolves. */
  stop(): void;
  /** The recording, once stopped (by `stop` or the time limit). */
  done: Promise<Blob>;
}

/** Why the microphone could not be opened, in words. */
export function microphoneError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The microphone is blocked. Allow it for this site in the browser, then try again.';
  if (name === 'NotFoundError') return 'No microphone was found.';
  return `The microphone could not be opened: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Start recording the microphone; stops by itself after `maxMs`. Throws when
 * the microphone cannot be opened (see `microphoneError`).
 */
export async function startClipRecorder(maxMs: number): Promise<ClipRecorder> {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot record audio.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const preferred = ['audio/webm', 'audio/ogg'].find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stop = () => {
    if (recorder.state === 'recording') recorder.stop();
  };
  const timer = setTimeout(stop, maxMs);
  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
      resolve(new Blob(chunks, { type: recorder.mimeType || preferred || 'audio/webm' }));
    };
    recorder.onerror = () => {
      clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
      reject(new Error('The recording failed.'));
    };
  });
  recorder.start();
  return { stream, stop, done };
}

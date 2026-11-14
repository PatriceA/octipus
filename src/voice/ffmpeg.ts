/**
 * ffmpeg and ffprobe for recordings a user or a model hands over.
 *
 * Input is only ever a local file of an audio or video container: the demuxer
 * whitelist keeps a file named `.wav` that is really an HLS playlist (which
 * would read other files by absolute path) from being opened as one, and the
 * protocol whitelist keeps ffmpeg on the file it was given. Output is quiet,
 * stderr is drained while it runs, and a run that hangs is killed.
 */
import { resolve } from 'node:path';
import { spawnProcess } from '@/utils/proc';

/** Demuxers of real audio/video containers (ffmpeg names; `mov` covers mp4/m4a/3gp). */
export const MEDIA_DEMUXERS = 'wav,mp3,ogg,flac,aac,amr,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,asf,caf,aiff,au,w64,mpegts,mpeg,flv';

/** The arguments that make ffmpeg/ffprobe read `path` and nothing else. */
export function safeInput(path: string): string[] {
  // Absolute: a name starting with `-` is never read as an option.
  return ['-protocol_whitelist', 'file', '-format_whitelist', MEDIA_DEMUXERS, '-i', resolve(path)];
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  let tail = '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    tail = (tail + decoder.decode(value, { stream: true })).slice(-2000);
  }
  return tail;
}

/** Run a tool of the ffmpeg suite; throws with the end of stderr on failure or after `timeoutMs`. */
export async function runFfmpegTool(command: 'ffmpeg' | 'ffprobe', args: string[], timeoutMs = 30 * 60_000): Promise<string> {
  let proc: ReturnType<typeof spawnProcess>;
  try {
    proc = spawnProcess({ command, args: command === 'ffmpeg' ? ['-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats', ...args] : ['-v', 'error', ...args], stdout: command === 'ffprobe' ? 'pipe' : 'ignore', stderr: 'pipe' });
  } catch {
    throw new Error(`${command} is required to read this recording but was not found. Install ffmpeg.`);
  }
  if (proc.spawnError) throw new Error(`${command} is required to read this recording but was not found. Install ffmpeg.`);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  timer.unref?.();
  const [stdout, stderr] = await Promise.all([drain(proc.stdout), drain(proc.stderr), proc.exited]);
  clearTimeout(timer);
  if (timedOut) throw new Error(`${command} took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`);
  if (proc.exitCode !== 0) throw new Error(`${command} failed (exit ${proc.exitCode}): ${stderr.trim().slice(-300) || 'not a recording this install can read'}`);
  return stdout;
}

/** The length of a recording in seconds, or null when ffprobe cannot tell. */
export async function probeDurationSeconds(path: string): Promise<number | null> {
  try {
    const out = await runFfmpegTool('ffprobe', ['-protocol_whitelist', 'file', '-format_whitelist', MEDIA_DEMUXERS, '-show_entries', 'format=duration', '-of', 'csv=p=0', resolve(path)], 60_000);
    const seconds = Number.parseFloat(out.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/** The length of a clip in memory, in seconds (a temp file for ffprobe), or null when unknown. */
export async function probeBufferSeconds(audio: Buffer, format: string | undefined): Promise<number | null> {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'octipus-probe-'));
  try {
    const file = join(dir, `clip.${(format ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'}`);
    await writeFile(file, audio);
    return await probeDurationSeconds(file);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

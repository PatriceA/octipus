/**
 * Downloads for the local engine: streamed to a `.part` file with byte
 * progress, resumed with `Range` after a dropped connection, and accepted
 * only when the SHA-256 matches the pin. Nothing is used before it is verified.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ProgressFn = (done: number, total: number | null) => void;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve()).on('error', reject);
  });
  return hash.digest('hex');
}

const MAX_ATTEMPTS = 4;
/** A connection that sends nothing for this long is dropped (and resumed). */
const IDLE_TIMEOUT_MS = 60_000;

/** Write a chunk, honouring back-pressure; a stream error (ENOSPC, a removed folder) rejects. */
function writeChunk(out: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { out.off('drain', onDrain); reject(err); };
    const onDrain = () => { out.off('error', onError); resolve(); };
    out.once('error', onError);
    if (out.write(chunk)) { out.off('error', onError); resolve(); return; }
    out.once('drain', onDrain);
  });
}

function closeStream(out: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (out.destroyed) { resolve(); return; }
    out.once('error', reject);
    out.end(() => { out.off('error', reject); resolve(); });
  });
}

/**
 * Download `url` to `target`, verifying `sha256` (and `size` when known).
 * Resumes a partial `.part` from an earlier attempt or run; a resumed file
 * that does not verify (an older revision's leftover) is fetched again from
 * the start, once. A connection idle for a minute is dropped and resumed.
 */
export async function downloadVerified(url: string, target: string, sha256: string, opts: { size?: number; onProgress?: ProgressFn; signal?: AbortSignal; idleTimeoutMs?: number } = {}): Promise<void> {
  const idleMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const part = `${target}.part`;
  let lastError: unknown;
  let restarted = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error('Download cancelled');
    // The folder may have been removed meanwhile; recreate it each attempt.
    await mkdir(dirname(target), { recursive: true });
    const have = (await stat(part).catch(() => null))?.size ?? 0;
    const idle = new AbortController();
    let idleTimer = setTimeout(() => idle.abort(new Error(`No data from ${url} for ${idleMs / 1000} s`)), idleMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, idle.signal]) : idle.signal;
    let out: WriteStream | null = null;
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'octipus-local-engine', ...(have > 0 ? { range: `bytes=${have}-` } : {}) }, redirect: 'follow', signal });
      if (res.status === 416) { await rm(part, { force: true }); continue; }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const resumed = res.status === 206;
      const length = Number(res.headers.get('content-length') ?? 0) || null;
      const total = opts.size ?? (length !== null ? (resumed ? have + length : length) : null);
      let done = resumed ? have : 0;
      out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      const reader = res.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(new Error(`No data from ${url} for ${idleMs / 1000} s`)), idleMs);
        await writeChunk(out, value);
        done += value.byteLength;
        if (opts.size && done > opts.size) throw new Error(`${url} is larger than the pinned ${opts.size} bytes`);
        opts.onProgress?.(done, total);
      }
      await closeStream(out);
      out = null;
      const actual = await sha256File(part);
      if (actual !== sha256) {
        await rm(part, { force: true });
        if (resumed && !restarted) { restarted = true; attempt--; continue; }
        throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
      }
      await rename(part, target);
      return;
    } catch (err) {
      lastError = err;
      // Keep what was written (the next attempt resumes from it); a broken stream is just dropped.
      if (out) { const o = out; out = null; await closeStream(o).catch(() => o.destroy()); }
      if (opts.signal?.aborted || /Checksum mismatch|larger than the pinned/.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    } finally {
      clearTimeout(idleTimer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

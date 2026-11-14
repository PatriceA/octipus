/**
 * Downloads for the local engine: streamed to a `.part` file with byte
 * progress, resumed with `Range` after a dropped connection, and accepted
 * only when the SHA-256 matches the pin. Nothing is used before it is verified.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
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

/**
 * Download `url` to `target`, verifying `sha256` (and `size` when known).
 * Resumes a partial `.part` from an earlier attempt or run.
 */
export async function downloadVerified(url: string, target: string, sha256: string, opts: { size?: number; onProgress?: ProgressFn; signal?: AbortSignal } = {}): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const have = (await stat(part).catch(() => null))?.size ?? 0;
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'octipus-local-engine', ...(have > 0 ? { range: `bytes=${have}-` } : {}) }, redirect: 'follow', signal: opts.signal });
      if (res.status === 416) { await rm(part, { force: true }); continue; }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
      const resumed = res.status === 206;
      const length = Number(res.headers.get('content-length') ?? 0) || null;
      const total = opts.size ?? (length !== null ? (resumed ? have + length : length) : null);
      let done = resumed ? have : 0;
      const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
          done += value.byteLength;
          if (opts.size && done > opts.size) throw new Error(`${url} is larger than the pinned ${opts.size} bytes`);
          opts.onProgress?.(done, total);
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      const actual = await sha256File(part);
      if (actual !== sha256) {
        await rm(part, { force: true });
        throw new Error(`Checksum mismatch for ${url}: expected ${sha256}, got ${actual}`);
      }
      await rename(part, target);
      return;
    } catch (err) {
      lastError = err;
      if (opts.signal?.aborted || /Checksum mismatch|larger than the pinned/.test((err as Error).message)) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

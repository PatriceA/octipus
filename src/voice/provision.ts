import { spawnProcess as spawn, whichSync } from '@/utils/proc';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileAt, writeFileAt } from '@/utils/fs-file';

/**
 * Provisioning for the two local voice engines (faster-whisper STT, Kokoro TTS).
 * Both run through `uv` (no global pip/npm install): the Python deps resolve into
 * an ephemeral uv env on first use and the model files are downloaded here. This
 * is what `octi setup` drives; see docs/plans/voice-local-setup.md.
 */

export type ProgressFn = (line: string) => void;

/** True when `uv` (astral.sh/uv) is on PATH — the prerequisite for both local engines. */
export function hasUv(): boolean {
  return whichSync('uv') !== null;
}

export const UV_INSTALL_HINT =
  'Install `uv` first: `curl -LsSf https://astral.sh/uv/install.sh | sh` (see https://astral.sh/uv).';

// ── faster-whisper STT ───────────────────────────────────────────────────────

/** User-facing size/RAM guidance per faster-whisper model (int8 on CPU). */
export const FASTER_WHISPER_MODELS = [
  { id: 'tiny', download: '~75 MB', ram: '~1 GB', note: 'fastest, lowest accuracy' },
  { id: 'base', download: '~145 MB', ram: '~1 GB', note: 'fast, low accuracy' },
  { id: 'small', download: '~480 MB', ram: '~2 GB', note: 'recommended — big accuracy jump, realtime on CPU' },
  { id: 'medium', download: '~1.5 GB', ram: '~5 GB', note: 'near-best; realtime only on a fast multi-core CPU' },
  { id: 'large', download: '~3 GB', ram: '~10 GB', note: 'best; needs a GPU or very fast CPU for realtime' },
] as const;

export type FasterWhisperModel = (typeof FASTER_WHISPER_MODELS)[number]['id'];

/**
 * Prewarm faster-whisper: resolve the uv env and download the CT2 model to the
 * HF cache so the first real turn isn't slow. Throws if uv is missing or the
 * download fails.
 */
export async function installFasterWhisper(model: FasterWhisperModel, onProgress: ProgressFn = () => {}): Promise<void> {
  if (!hasUv()) throw new Error(`faster-whisper needs uv. ${UV_INSTALL_HINT}`);
  onProgress(`Downloading faster-whisper "${model}" (int8) …`);
  const proc = spawn({
    cmd: [
      'uv', 'run', '--python', '3.12', '--with', 'faster-whisper',
      'python', '-c',
      `from faster_whisper import WhisperModel; WhisperModel("${model}", device="cpu", compute_type="int8"); print("ok")`,
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Surface uv/model-download progress (stderr) line by line.
  void streamLines(proc.stderr!, onProgress);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`faster-whisper prewarm failed (exit ${code}); check that uv can reach the network.`);
  onProgress(`faster-whisper "${model}" ready.`);
}

// ── Kokoro TTS ───────────────────────────────────────────────────────────────

const KOKORO_RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
const KOKORO_FILES = [
  { name: 'kokoro-v1.0.onnx', url: `${KOKORO_RELEASE}/kokoro-v1.0.onnx` },
  { name: 'voices-v1.0.bin', url: `${KOKORO_RELEASE}/voices-v1.0.bin` },
];

/** Where Kokoro's ONNX model + voices live; the engine and installer share this. */
export function kokoroModelDir(): string {
  return process.env.KOKORO_MODEL_DIR || join(homedir(), '.local', 'share', 'kokoro');
}

/** True when both Kokoro model files are present in {@link kokoroModelDir}. */
export async function kokoroModelsPresent(): Promise<boolean> {
  const dir = kokoroModelDir();
  for (const f of KOKORO_FILES) {
    if (!(await fileAt(join(dir, f.name)).exists())) return false;
  }
  return true;
}

export const KOKORO_SIZE_NOTE = '~340 MB model (ONNX + voices), ~1 GB RAM';

/**
 * Provision Kokoro: ensure uv is present and download the ONNX model + voices to
 * {@link kokoroModelDir} (idempotent — skips files already there). The engine
 * runs the model via `uv run --with kokoro-onnx`, so nothing else is installed.
 */
export async function installKokoro(onProgress: ProgressFn = () => {}): Promise<void> {
  if (!hasUv()) throw new Error(`Kokoro needs uv. ${UV_INSTALL_HINT}`);
  const dir = kokoroModelDir();
  await mkdir(dir, { recursive: true });
  for (const f of KOKORO_FILES) {
    const dest = join(dir, f.name);
    if (await fileAt(dest).exists()) {
      onProgress(`${f.name} already present.`);
      continue;
    }
    onProgress(`Downloading ${f.name} …`);
    const res = await fetch(f.url);
    if (!res.ok || !res.body) throw new Error(`Kokoro model download failed for ${f.name} (${res.status}).`);
    await writeFileAt(dest, res);
  }
  onProgress('Kokoro ready.');
}

/** Stream a piped stderr/stdout as decoded lines to a progress callback. */
async function streamLines(stream: ReadableStream<Uint8Array>, onProgress: ProgressFn): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        if (line) onProgress(line);
        buf = buf.slice(idx + 1);
      }
    }
  } catch {
    /* stream closed */
  }
}

import { spawn, which } from 'bun';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { logger } from '../utils/logger';

/**
 * Cross-platform provisioning + detection for local whisper.cpp STT.
 *
 * The repo historically shipped one dynamically-linked `whisper-cpp` binary with
 * no libraries, so it exited 127 on a clean host and STT silently failed. This
 * module makes local voice a real, checkable, installable dependency on Linux,
 * macOS and Windows: it resolves an OS/arch-specific binary, actually *runs* it
 * to confirm it works, and can build it (plus its libs) from source on demand.
 */

// Bump to move the pinned whisper.cpp version the installer builds.
const WHISPER_TAG = 'v1.7.4';
const WHISPER_REPO = 'https://github.com/ggerganov/whisper.cpp';
const MODEL_FILE = 'ggml-base.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;

const EXE = process.platform === 'win32' ? '.exe' : '';

/** `<projectRoot>/models/whisper` — the module lives in `src/voice/`. */
function whisperRoot(): string {
  const projectRoot = resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../..');
  return resolve(projectRoot, 'models/whisper');
}

/** Per-platform install dir, e.g. `models/whisper/linux-x64`. */
export function whisperDir(): string {
  return join(whisperRoot(), `${process.platform}-${process.arch}`);
}

/** Where the installer places the binary (`whisper-cli[.exe]`). */
export function whisperBinaryPath(): string {
  return join(whisperDir(), `whisper-cli${EXE}`);
}

/** The ggml model path (shared across platforms). */
export function whisperModelPath(): string {
  return join(whisperRoot(), MODEL_FILE);
}

/**
 * Resolve the per-platform binary to spawn, or null if not installed. We do NOT
 * fall back to the legacy committed `models/whisper/whisper-cpp`: that binary is
 * dynamically linked without its libs (exit 127), and handing it back would
 * resurrect the exact silent-failure this module removes. `octi setup` installs
 * a real per-platform binary.
 */
export async function resolveWhisperBinary(): Promise<string | null> {
  const perPlatform = whisperBinaryPath();
  return (await Bun.file(perPlatform).exists()) ? perPlatform : null;
}

/**
 * Env additions so a co-located binary finds its shared libs without a
 * system-wide install. Windows resolves DLLs next to the .exe automatically.
 */
export function whisperSpawnEnv(binaryPath: string): Record<string, string> {
  const dir = dirname(binaryPath);
  const env = { ...process.env } as Record<string, string>;
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${dir}:${env.DYLD_LIBRARY_PATH}` : dir;
  } else if (process.platform !== 'win32') {
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${dir}:${env.LD_LIBRARY_PATH}` : dir;
  }
  return env;
}

export interface WhisperProbe {
  binaryOk: boolean;
  binaryReason: string | null;
  modelOk: boolean;
  binaryPath: string | null;
  modelPath: string;
}

// Availability changes only at install time, but probeWhisper forks a
// subprocess and /voice/status is polled per page load — so cache the result and
// invalidate it after an install.
let cachedProbe: WhisperProbe | null = null;
export function invalidateWhisperProbe(): void {
  cachedProbe = null;
}

/**
 * Detect whether local whisper *actually works* — not just whether a config
 * value is set. Runs the binary (`--help`) so a missing-libs (exit 127) or
 * missing-binary (ENOENT) failure is caught, and checks the model file. Cached.
 */
export async function probeWhisper(): Promise<WhisperProbe> {
  if (cachedProbe) return cachedProbe;
  const modelPath = whisperModelPath();
  const modelOk = await Bun.file(modelPath).exists();
  const binaryPath = await resolveWhisperBinary();

  if (!binaryPath) {
    return (cachedProbe = { binaryOk: false, binaryReason: 'whisper binary not installed', modelOk, binaryPath: null, modelPath });
  }
  try {
    const proc = spawn({
      cmd: [binaryPath, '--help'],
      stdout: 'ignore',
      stderr: 'pipe',
      env: whisperSpawnEnv(binaryPath),
    });
    await proc.exited;
    // A healthy `whisper-cli --help` exits 0; a shared-lib load failure exits
    // 127. Require 0 so an ABI-broken binary that errors out isn't reported OK.
    if (proc.exitCode === 0) {
      return (cachedProbe = { binaryOk: true, binaryReason: null, modelOk, binaryPath, modelPath });
    }
    const stderr = await new Response(proc.stderr).text();
    const reason = /cannot open shared object|not found|libwhisper|libggml/i.test(stderr)
      ? 'whisper binary present but its shared libraries are missing — reinstall local voice'
      : `whisper binary failed to run (exit ${proc.exitCode})`;
    return (cachedProbe = { binaryOk: false, binaryReason: reason, modelOk, binaryPath, modelPath });
  } catch (err) {
    return (cachedProbe = { binaryOk: false, binaryReason: `whisper binary could not be spawned: ${(err as Error).message}`, modelOk, binaryPath, modelPath });
  }
}

export interface VoiceAvailability {
  stt: { local: boolean; external: boolean; available: boolean; reason: string | null };
  tts: { available: boolean; provider: string; reason: string | null };
}

/**
 * Whole-feature availability: local whisper OR a configured external provider.
 * Voice UI gates on `stt.available` (and `tts.available` for spoken replies).
 */
export async function getVoiceAvailability(opts: {
  ttsProvider: string;
  hasMistralKey: boolean;
  hasOpenAIKey: boolean;
  piperModelPath?: string;
}): Promise<VoiceAvailability> {
  const probe = await probeWhisper();
  const local = probe.binaryOk && probe.modelOk;
  const external = opts.hasMistralKey || opts.hasOpenAIKey;
  const sttReason = local || external
    ? null
    : probe.binaryReason
      ? `${probe.binaryReason}. Run \`octi setup\` to install local voice, or configure a cloud STT key.`
      : 'No local whisper and no cloud STT key configured.';

  // TTS: mistral needs a key; piper needs its model; edge/coqui need their host
  // tools (assume present if explicitly selected). Only the mistral path is
  // strictly checkable here.
  let ttsAvailable: boolean;
  let ttsReason: string | null = null;
  if (opts.ttsProvider === 'mistral') {
    ttsAvailable = opts.hasMistralKey;
    if (!ttsAvailable) ttsReason = 'Mistral TTS selected but no Mistral API key configured.';
  } else if (opts.ttsProvider === 'piper') {
    ttsAvailable = !!opts.piperModelPath;
    if (!ttsAvailable) ttsReason = 'Piper TTS selected but no piper model path configured.';
  } else {
    ttsAvailable = true; // edge/coqui — validated at synthesis time
  }

  return {
    stt: { local, external, available: local || external, reason: sttReason },
    tts: { available: ttsAvailable, provider: opts.ttsProvider, reason: ttsReason },
  };
}

export type InstallProgress = (line: string) => void;

/** Thrown when the host lacks the build toolchain; message carries the remedy. */
export class ToolchainMissingError extends Error {}

let installInFlight: Promise<void> | null = null;

/**
 * Build whisper.cpp from source and stage the binary + shared libs into the
 * per-platform dir. Idempotent-ish: concurrent calls share one build.
 */
export async function installWhisper(onProgress: InstallProgress = () => {}): Promise<void> {
  if (installInFlight) {
    onProgress('A whisper build is already in progress; waiting for it…');
    return installInFlight;
  }
  installInFlight = doInstall(onProgress).finally(() => { installInFlight = null; });
  return installInFlight;
}

async function doInstall(onProgress: InstallProgress): Promise<void> {
  await assertToolchain();

  const buildParent = join(whisperRoot(), '.build');
  const srcDir = join(buildParent, 'whisper.cpp');
  const buildDir = join(srcDir, 'build');
  await mkdir(buildParent, { recursive: true });
  await rm(srcDir, { recursive: true, force: true });

  onProgress(`Cloning whisper.cpp ${WHISPER_TAG}…`);
  await run(['git', 'clone', '--depth', '1', '--branch', WHISPER_TAG, WHISPER_REPO, srcDir], onProgress);

  onProgress('Configuring (cmake)…');
  await run(['cmake', '-S', srcDir, '-B', buildDir, '-DBUILD_SHARED_LIBS=ON', '-DCMAKE_BUILD_TYPE=Release', '-DWHISPER_BUILD_EXAMPLES=ON'], onProgress);

  onProgress('Building (this can take a few minutes)…');
  await run(['cmake', '--build', buildDir, '--config', 'Release', '-j'], onProgress);

  onProgress('Staging binary + libraries…');
  const dir = whisperDir();
  await mkdir(dir, { recursive: true });
  const artifacts = await collectArtifacts(buildDir);
  if (!artifacts.binary) {
    throw new Error('Build finished but no whisper-cli binary was produced.');
  }
  // dereference: the build tree symlinks sonames (libwhisper.so.1 → …so.1.7.4);
  // copy real bytes so the staged dir survives deleting the build tree below.
  await cp(artifacts.binary, whisperBinaryPath(), { dereference: true });
  if (process.platform !== 'win32') await run(['chmod', '+x', whisperBinaryPath()], onProgress);
  for (const lib of artifacts.libs) {
    await cp(lib, join(dir, basename(lib)), { dereference: true });
  }

  await ensureModel(onProgress);

  // Prove it: the whole point was catching the silent 127. Drop the stale cached
  // "not installed" probe first so this re-runs against the freshly staged files.
  invalidateWhisperProbe();
  const probe = await probeWhisper();
  if (!probe.binaryOk) {
    throw new Error(`Whisper built but still won't run: ${probe.binaryReason}`);
  }

  // Drop the source/build tree (hundreds of MB) now that the artifacts are staged.
  await rm(buildParent, { recursive: true, force: true });
  onProgress('Local voice installed and verified.');
  logger.info({ dir, tag: WHISPER_TAG }, 'whisper.cpp built + staged');
}

/** Ensure the ggml model is present; download if missing. */
async function ensureModel(onProgress: InstallProgress): Promise<void> {
  const model = whisperModelPath();
  if (await Bun.file(model).exists()) return;
  onProgress(`Downloading ${MODEL_FILE}…`);
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  await Bun.write(model, res);
}

async function assertToolchain(): Promise<void> {
  const missing: string[] = [];
  if (!(await which('git'))) missing.push('git');
  if (!(await which('cmake'))) missing.push('cmake');
  const hasCompiler =
    (await which('cc')) || (await which('gcc')) || (await which('clang')) || (await which('cl'));
  if (!hasCompiler) missing.push('a C/C++ compiler');
  if (missing.length === 0) return;

  const remedy =
    process.platform === 'darwin'
      ? 'macOS: `xcode-select --install` then `brew install cmake`.'
      : process.platform === 'win32'
        ? 'Windows: install Visual Studio Build Tools (C++), plus `winget install Kitware.CMake Git.Git`.'
        : 'Linux: install your distro build tools + cmake (e.g. `sudo pacman -S base-devel cmake git` or `sudo apt install build-essential cmake git`).';
  throw new ToolchainMissingError(`Missing build tools: ${missing.join(', ')}. ${remedy}`);
}

interface Artifacts { binary: string | null; libs: string[]; }

/** Walk the build tree for the whisper-cli binary and all shared libs. */
async function collectArtifacts(buildDir: string): Promise<Artifacts> {
  // Anchor to the extension so a substring like ".so" doesn't sweep up cruft
  // (foo.so.bak, x.so.tmp): match `.so`/`.so.1`/`.so.1.7.4`, `.dylib`, `.dll`.
  const libRe =
    process.platform === 'darwin' ? /\.dylib$/ : process.platform === 'win32' ? /\.dll$/ : /\.so(\.\d+)*$/;
  const binaryName = `whisper-cli${EXE}`;
  const out: Artifacts = { binary: null, libs: [] };

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.name === binaryName && !out.binary) {
        out.binary = full;
      } else if (libRe.test(e.name)) {
        // matches libwhisper.so.1, libggml.so, libggml-cpu.dylib, whisper.dll, …
        out.libs.push(full);
      }
    }
  }
  await walk(buildDir);
  return out;
}

async function run(cmd: string[], onProgress: InstallProgress): Promise<void> {
  const proc = spawn({ cmd, stdout: 'pipe', stderr: 'pipe' });
  // Surface build output line-by-line so a caller can stream it.
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onProgress(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) onProgress(buf);
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`Command failed (exit ${proc.exitCode}): ${cmd.join(' ')}`);
  }
}

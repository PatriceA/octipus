/**
 * The resident speech workers (src/voice/stt.ts FasterWhisperEngine,
 * src/voice/resident-worker.ts for Kokoro), driven against small Node
 * processes that speak the same protocols: a refused request keeps the
 * worker, one that dies is replaced, and an idle one is stopped.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ calls: [] as Array<{ command: string; args: string[] }> }));

/** The faster-whisper worker's framing: a 4-byte length, then PCM. The first byte says what to do. */
const FAKE_FASTER_WHISPER = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ ready: true, device: 'cpu' });
let buf = Buffer.alloc(0);
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) {
    const n = buf.readUInt32BE(0);
    if (buf.length < 4 + n) break;
    const op = buf[4];
    buf = buf.subarray(4 + n);
    if (op === 1) out({ error: 'this window could not be decoded' });
    else if (op === 2) process.exit(3);
    else out({ text: String(process.pid), segments: [] });
  }
});
`;

vi.mock('@/utils/proc', async (orig) => {
  const real = await orig<typeof import('@/utils/proc')>();
  return {
    ...real,
    // `uv run … faster_whisper_worker.py` becomes the fake worker; what it was asked to run is kept.
    spawnProcess: (config: Parameters<typeof real.spawnProcess>[0]) => {
      if (config.command !== 'uv') return real.spawnProcess(config);
      spawned.calls.push({ command: config.command, args: config.args ?? [] });
      return real.spawnProcess({ ...config, command: process.execPath, args: ['-e', FAKE_FASTER_WHISPER] });
    },
  };
});

const { FasterWhisperEngine } = await import('./stt');
const { ResidentWorker } = await import('./resident-worker');

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('faster-whisper worker', () => {
  type Internals = { sendDetailed(pcm: Uint8Array): Promise<{ text: string }>; proc: { pid: number; exitCode: number | null } | null };
  let engine: InstanceType<typeof FasterWhisperEngine>;
  afterEach(async () => { await engine?.dispose(); });

  const window = (op: number) => new Uint8Array([op, 0, 0, 0]);

  test('a refused window keeps the worker; one that dies is replaced, also when it died between requests', async () => {
    engine = new FasterWhisperEngine({ model: 'small', language: 'en-US', device: 'auto' });
    const w = engine as unknown as Internals;
    const first = (await w.sendDetailed(window(0))).text;

    // An {"error"} reply: the worker is alive and keeps its loaded model.
    await expect(w.sendDetailed(window(1))).rejects.toThrow(/could not be decoded/);
    expect((await w.sendDetailed(window(0))).text).toBe(first);

    // The worker exits mid-request: the request fails, the next one gets a new worker.
    await expect(w.sendDetailed(window(2))).rejects.toThrow(/closed unexpectedly/);
    const second = (await w.sendDetailed(window(0))).text;
    expect(second).not.toBe(first);

    // Killed while idle: replaced before it is written to, so the request does not fail.
    process.kill(Number(second));
    await until(() => w.proc?.exitCode !== null);
    const third = (await w.sendDetailed(window(0))).text;
    expect(third).not.toBe(second);
  });

  test('the worker is asked for a two-letter language; a CPU-only host is not sent the CUDA libraries', async () => {
    spawned.calls.length = 0;
    engine = new FasterWhisperEngine({ model: 'small', language: 'de_DE', device: 'auto' });
    await (engine as unknown as Internals).sendDetailed(window(0));
    const args = spawned.calls[0].args;
    expect(args[args.indexOf('--language') + 1]).toBe('de');
    const { existsSync } = await import('node:fs');
    if (!existsSync('/dev/nvidiactl')) expect(args).not.toContain('nvidia-cublas-cu12');
  });
});

/** A JSON-lines worker: `crash` exits, `fail` is refused, anything else answers with the pid. */
const FAKE_KOKORO = `
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  if (req.crash) process.exit(1);
  process.stdout.write(JSON.stringify(req.fail ? { error: 'no such voice' } : { pid: process.pid }) + '\\n');
});
`;

describe('resident worker', () => {
  let worker: InstanceType<typeof ResidentWorker>;
  afterEach(async () => { await worker?.stop(); });

  test('a refused request keeps the worker; a crash is replaced by the next request', async () => {
    worker = new ResidentWorker('Test', process.execPath, ['-e', FAKE_KOKORO]);
    const { pid } = await worker.request<{ pid: number }>({});
    await expect(worker.request({ fail: true })).rejects.toThrow(/no such voice/);
    expect((await worker.request<{ pid: number }>({})).pid).toBe(pid);
    await expect(worker.request({ crash: true })).rejects.toThrow(/closed unexpectedly/);
    expect((await worker.request<{ pid: number }>({})).pid).not.toBe(pid);
  });

  test('a worker that died while idle is replaced before it is written to', async () => {
    worker = new ResidentWorker('Test', process.execPath, ['-e', FAKE_KOKORO]);
    const { pid } = await worker.request<{ pid: number }>({});
    process.kill(pid);
    await until(() => !worker.running);
    expect((await worker.request<{ pid: number }>({})).pid).not.toBe(pid);
  });

  test('an idle worker is stopped, and started again when asked', async () => {
    worker = new ResidentWorker('Test', process.execPath, ['-e', FAKE_KOKORO], 50);
    const { pid } = await worker.request<{ pid: number }>({});
    expect(worker.running).toBe(true);
    await until(() => !worker.running);
    expect((await worker.request<{ pid: number }>({})).pid).not.toBe(pid);
  });

  test('a worker that cannot start says why', async () => {
    worker = new ResidentWorker('Test', process.execPath, ['-e', `process.stdout.write(JSON.stringify({ error: 'model files missing' }) + '\\n')`]);
    await expect(worker.request({})).rejects.toThrow(/Test worker failed to start: model files missing/);
    expect(worker.running).toBe(false);
  });
});

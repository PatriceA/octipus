/**
 * scripts/supervisor.mjs — the repair ladder, and recovery mode end to end.
 *
 * The end-to-end cases run the real supervisor against stand-in backends (a
 * script that crashes, one that answers /api/health) on free ports, with the
 * state directory and the last-good build in a temp directory.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain ESM script without type declarations
import { nextStep, probeHost, resolveSettings, tokenMatches } from './supervisor.mjs';

const SUPERVISOR = join(dirname(fileURLToPath(import.meta.url)), 'supervisor.mjs');
const TOKEN = 'test-recovery-token';

/**
 * Answers /api/health, unless a `broken` file sits next to it (then it crashes
 * on boot). With a `crash-once` file it deletes the file and dies a second
 * after coming up.
 */
const BACKEND = `
import { createServer } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
if (existsSync(join(import.meta.dirname, 'broken'))) { console.error('boom: backend is broken'); process.exit(3); }
if (existsSync(join(import.meta.dirname, 'crash-once'))) { rmSync(join(import.meta.dirname, 'crash-once')); setTimeout(() => process.exit(9), 1500); }
createServer((req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); }).listen(Number(process.env.API_PORT), '127.0.0.1');
console.log('stand-in backend up');
`;

describe('nextStep', () => {
  test('retries the same build first, with a growing delay', () => {
    expect(nextStep({ failures: 1, build: 'current', lastGoodAvailable: true, maxRetries: 3 })).toEqual({ action: 'retry', build: 'current', delayMs: 2000 });
    expect(nextStep({ failures: 2, build: 'current', lastGoodAvailable: true, maxRetries: 3 })).toEqual({ action: 'retry', build: 'current', delayMs: 4000 });
  });

  test('then falls back to the last good build once', () => {
    expect(nextStep({ failures: 2, build: 'current', lastGoodAvailable: true, maxRetries: 2 })).toMatchObject({ action: 'retry', build: 'last-good' });
  });

  test('goes to recovery when there is no other build to try', () => {
    expect(nextStep({ failures: 2, build: 'current', lastGoodAvailable: false, maxRetries: 2 })).toEqual({ action: 'recovery' });
    expect(nextStep({ failures: 3, build: 'last-good', lastGoodAvailable: true, maxRetries: 2 })).toEqual({ action: 'recovery' });
  });
});

describe('settings and helpers', () => {
  test('resolves host and port the way the backend does, environment before .env', () => {
    const s = resolveSettings({ API_PORT: '4100', OCTIPUS_STATE_DIR: '/tmp/x' }, '/proj', { API_PORT: '9999', HOST: '127.0.0.1', WEB_PORT: '4200' });
    expect(s).toMatchObject({ port: 4100, host: '127.0.0.1', webPort: 4200, stateDir: '/tmp/x', entry: '/proj/dist/index.js', lastGoodDir: '/proj/.last-good-build' });
    expect(resolveSettings({}, '/proj', {}).host).toBe('0.0.0.0');
  });

  test('probes a wildcard bind on loopback', () => {
    expect(probeHost('0.0.0.0')).toBe('127.0.0.1');
    expect(probeHost('::')).toBe('127.0.0.1');
    expect(probeHost('10.0.0.2')).toBe('10.0.0.2');
  });

  test('token check rejects anything but the exact token', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abc', 'abcd')).toBe(false);
    expect(tokenMatches('abc', '')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches('abc', undefined)).toBe(false);
  });
});

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('condition not met in time');
}

interface Run {
  dir: string;
  port: number;
  child: ChildProcess;
  url: (path: string) => string;
  state: () => Record<string, unknown>;
  /** Wait until the supervisor reports this mode and build. */
  reaches: (mode: string, build?: string) => Promise<void>;
}

const runs: Run[] = [];

async function startSupervisor(opts: { broken?: boolean; crashOnce?: boolean; lastGood?: boolean; env?: Record<string, string> } = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'octi-supervisor-'));
  const build = join(dir, 'dist');
  mkdirSync(build);
  writeFileSync(join(build, 'index.js'), `// current\n${BACKEND}`);
  if (opts.broken) writeFileSync(join(build, 'broken'), '');
  if (opts.crashOnce) writeFileSync(join(build, 'crash-once'), '');
  if (opts.lastGood) {
    mkdirSync(join(dir, 'last-good'));
    writeFileSync(join(dir, 'last-good', 'index.js'), `// last good\n${BACKEND}`);
  }
  const port = await freePort();
  const child = spawn(process.execPath, [SUPERVISOR], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      API_PORT: String(port),
      API_HOST: '127.0.0.1',
      OCTIPUS_STATE_DIR: join(dir, 'state'),
      OCTIPUS_SUPERVISOR_ENTRY: join(build, 'index.js'),
      OCTIPUS_LAST_GOOD_DIR: join(dir, 'last-good'),
      OCTIPUS_RECOVERY_TOKEN: TOKEN,
      OCTIPUS_BOOT_TIMEOUT_MS: '10000',
      OCTIPUS_BOOT_RETRIES: '1',
      ...opts.env,
    },
    stdio: 'ignore',
  });
  const run: Run = {
    dir,
    port,
    child,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    state: () => JSON.parse(readFileSync(join(dir, 'state', 'supervisor.json'), 'utf8')),
    reaches: async (mode, build) => {
      await until(async () => {
        const state = run.state();
        return state.mode === mode && (!build || state.build === build) ? true : undefined;
      });
    },
  };
  runs.push(run);
  return run;
}

afterEach(async () => {
  for (const run of runs.splice(0)) {
    if (run.child.exitCode === null) {
      const exited = new Promise((r) => run.child.once('exit', r));
      run.child.kill('SIGTERM');
      await exited;
    }
    rmSync(run.dir, { recursive: true, force: true });
  }
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('supervisor end to end', () => {
  test('a healthy backend runs, and is kept as the last good build once stable', async () => {
    const run = await startSupervisor({ env: { OCTIPUS_STABLE_MS: '500' } });
    await run.reaches('running', 'current');
    expect((await fetch(run.url('/api/health'))).status).toBe(200);
    await until(async () => (existsSync(join(run.dir, 'last-good', 'build.json')) ? true : undefined));
    expect(readFileSync(join(run.dir, 'last-good', 'index.js'), 'utf8')).toContain('// current');
  }, 30_000);

  test('a backend that dies while running is started again', async () => {
    // Stable after 500 ms; the stand-in dies 1.5 s after starting.
    const run = await startSupervisor({ crashOnce: true, env: { OCTIPUS_STABLE_MS: '500' } });
    await until(async () => {
      const state = run.state() as { mode: string; attempts: Array<{ outcome: string; exitCode: number }> };
      const crashed = state.attempts.some((a) => a.outcome === 'exited-while-running' && a.exitCode === 9);
      return crashed && state.mode === 'running' ? true : undefined;
    });
    expect((await fetch(run.url('/api/health'))).status).toBe(200);
  }, 30_000);

  test('a backend that will not boot falls back to the last good build', async () => {
    const run = await startSupervisor({ broken: true, lastGood: true });
    await run.reaches('running', 'last-good');
    expect((await fetch(run.url('/api/health'))).status).toBe(200);
  }, 30_000);

  test('with nothing that boots, recovery mode serves status and logs behind the token, and a retry brings it back', async () => {
    const run = await startSupervisor({ broken: true });
    const health = await until(async () => {
      const res = await fetch(run.url('/api/health'));
      return res.status === 503 ? ((await res.json()) as Record<string, unknown>) : undefined;
    });
    expect(health).toMatchObject({ status: 'recovery', mode: 'recovery' });
    expect(run.state()).toMatchObject({ mode: 'recovery' });

    // The page is public; the API is not.
    expect(await (await fetch(run.url('/api/recovery'))).text()).toContain('recovery mode');
    expect((await fetch(run.url('/api/recovery/status'))).status).toBe(401);
    expect((await fetch(run.url('/api/recovery/status'), { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    // No shell: an unknown action is a 404, not a command runner.
    expect((await fetch(run.url('/api/recovery/exec'), { method: 'POST', headers: auth, body: '{"command":"id"}' })).status).toBe(404);

    const status = (await (await fetch(run.url('/api/recovery/status'), { headers: auth })).json()) as { attempts: Array<{ outcome: string; exitCode: number; logTail: string[] }> };
    expect(status.attempts[0]).toMatchObject({ outcome: 'crashed', exitCode: 3 });
    expect(status.attempts[0].logTail.join('\n')).toContain('boom: backend is broken');

    const logs = (await (await fetch(run.url('/api/recovery/logs?lines=50'), { headers: auth })).json()) as { lines: string[] };
    expect(logs.lines.join('\n')).toContain('Entering recovery mode');

    // The operator fixes the cause, then asks for a retry.
    rmSync(join(run.dir, 'dist', 'broken'));
    const restart = await fetch(run.url('/api/recovery/restart'), { method: 'POST', headers: auth, body: '{}' });
    expect(restart.status).toBe(202);
    await run.reaches('running', 'current');
    expect((await fetch(run.url('/api/health'))).status).toBe(200);
  }, 40_000);
});

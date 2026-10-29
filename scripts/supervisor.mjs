#!/usr/bin/env node
/**
 * Backend supervisor: keeps an install reachable when its backend won't come up.
 *
 *   node scripts/supervisor.mjs            (what `octi start` and the Docker image run)
 *
 * Without it, a backend that failed to boot left nothing on the API port. A
 * restart from a phone that died in the middle meant no app, no web UI and no
 * way back in until someone sat down at the machine. The supervisor starts the
 * backend and repairs what it can on its own:
 *
 *   1. A boot that crashes, or doesn't answer /api/health before the deadline,
 *      is retried with a short backoff. That covers transient trouble: a port
 *      still being released, a database still starting, a network that isn't up.
 *   2. Still failing: start the last build that booted and stayed up (copied to
 *      `.last-good-build/` once a build has been healthy for a minute). A bad
 *      pull or a broken build is the usual reason a restart doesn't return.
 *   3. Still failing: recovery mode. A small HTTP server takes the API port
 *      (and the web port, when it is free) and serves a status page, the logs
 *      with the failed attempts' output, and token-protected actions: retry,
 *      rebuild and retry, start the last good build. You or an agent can see
 *      why it is down and bring it back remotely. Every so often it tries the
 *      backend again by itself, unless someone has used the recovery API in
 *      the last ten minutes.
 *
 * Once the backend is running, a process that stops answering health checks
 * for a minute is killed and restarted, as is one that crashes.
 *
 * No dependencies beyond Node itself, and nothing from `dist/` or
 * `node_modules/`: those are what is most likely to be broken when it's needed.
 *
 * Recovery token: `$OCTIPUS_RECOVERY_TOKEN`, else `~/.octipus/recovery-token`
 * (created on first run, mode 0600). `octi recovery` prints it. Store it
 * somewhere you can reach away from the machine. Without it the recovery
 * endpoints are of no use to you either.
 *
 * Environment:
 *   OCTIPUS_STATE_DIR          state directory (default ~/.octipus)
 *   OCTIPUS_SUPERVISOR_ENTRY   backend entry (default <project>/dist/index.js)
 *   OCTIPUS_BOOT_TIMEOUT_MS    how long a boot may take to answer health (default 120000)
 *   OCTIPUS_LAST_GOOD_DIR      where the last good build is kept (default <project>/.last-good-build)
 *   OCTIPUS_RECOVERY_TOKEN     use this token instead of the token file
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Same judgment as src/security/child-env.ts: what never goes to a spawned shell. */
const SENSITIVE_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)|^DATABASE_URL$|^REDIS_URL$/i;

const MAX_BODY_BYTES = 64 * 1024;
const MAX_EXEC_OUTPUT = 512 * 1024;
const LOG_RING_LINES = 2000;
/** Auto-retry delays in recovery mode; the last one repeats. */
const RECOVERY_RETRY_MS = [2, 5, 15, 30, 60].map((m) => m * 60_000);
/** Someone used the recovery API this recently: don't pull the server out from under them. */
const OPERATOR_QUIET_MS = 10 * 60_000;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Like num(), but 0 is a valid answer ("no retries"). */
function count(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Read the checkout's `.env` without putting its secrets into this process's environment. */
export function readDotenv(projectDir) {
  try {
    return parseEnv(readFileSync(join(projectDir, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

/** Ports, paths and limits, resolved the way the backend resolves them (src/config/bootstrap-loader.ts). */
export function resolveSettings(env = process.env, projectDir = PROJECT_DIR, dotenv = readDotenv(projectDir)) {
  const get = (name) => env[name] || dotenv[name] || '';
  const stateDir = env.OCTIPUS_STATE_DIR || join(homedir(), '.octipus');
  const host = get('API_HOST') || get('HOST') || '0.0.0.0';
  return {
    projectDir,
    stateDir,
    host,
    port: num(get('API_PORT') || get('PORT'), 3000),
    webPort: num(get('WEB_PORT'), 0),
    entry: env.OCTIPUS_SUPERVISOR_ENTRY || join(projectDir, 'dist', 'index.js'),
    lastGoodDir: env.OCTIPUS_LAST_GOOD_DIR || join(projectDir, '.last-good-build'),
    stateFile: join(stateDir, 'supervisor.json'),
    tokenFile: join(stateDir, 'recovery-token'),
    bootTimeoutMs: num(env.OCTIPUS_BOOT_TIMEOUT_MS, 120_000),
    stableMs: num(env.OCTIPUS_STABLE_MS, 60_000),
    healthIntervalMs: num(env.OCTIPUS_HEALTH_INTERVAL_MS, 10_000),
    /** Consecutive missed health checks before a running backend counts as hung. */
    hangChecks: num(env.OCTIPUS_HANG_CHECKS, 6),
    maxRetries: count(env.OCTIPUS_BOOT_RETRIES, 2),
    /** How long to wait for the API port to be free (before a boot, binding recovery), and between rebinds. */
    portWaitMs: num(env.OCTIPUS_PORT_WAIT_MS, 30_000),
  };
}

/** Where to probe the backend from this machine. A wildcard bind is reachable on loopback. */
export function probeHost(host) {
  return host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
}

/**
 * What to do after a boot attempt failed. `failures` counts consecutive failed
 * attempts, this one included.
 *
 * Retry the current build `maxRetries` times after the first attempt, then the
 * last good build once (when there is one that differs from the current
 * build), then give up to recovery.
 */
export function nextStep({ failures, build, lastGoodAvailable, maxRetries }) {
  if (build === 'last-good') return { action: 'recovery' };
  if (failures <= maxRetries) return { action: 'retry', build, delayMs: Math.min(2000 * 2 ** (failures - 1), 15_000) };
  if (lastGoodAvailable) return { action: 'retry', build: 'last-good', delayMs: 1000 };
  return { action: 'recovery' };
}

/** Constant-time token check; lengths are hidden by comparing digests. */
export function tokenMatches(expected, presented) {
  if (!expected || typeof presented !== 'string' || presented.length === 0) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}

/** The recovery token: the environment's, else the token file's, created on first use. */
export function ensureToken(settings, env = process.env) {
  if (env.OCTIPUS_RECOVERY_TOKEN) return env.OCTIPUS_RECOVERY_TOKEN.trim();
  try {
    const existing = readFileSync(settings.tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // Not there yet.
  }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(dirname(settings.tokenFile), { recursive: true });
  writeFileSync(settings.tokenFile, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(settings.tokenFile, 0o600);
  } catch {
    // Best effort (Windows).
  }
  return token;
}

function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function gitCommit(projectDir) {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectDir, encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Checkout identity alone cannot identify a copied or restored bundle. */
export function readBuildIdentity(entry) {
  const sha256 = sha256File(entry);
  try {
    const info = JSON.parse(readFileSync(join(dirname(entry),'build-info.json'),'utf8'));
    const outputsMatch = info.outputs && typeof info.outputs === 'object' && !Array.isArray(info.outputs) && info.outputs['index.js'] === sha256
      && Object.entries(info.outputs).every(([name,hash]) => (name === 'index.js' || /^[a-zA-Z0-9_.-]+\.py$/.test(name))
        && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && sha256File(join(dirname(entry),name)) === hash);
    if (info.version === 1 && sha256 && outputsMatch && info.bundleSha256 === sha256) return {
      sha256, commit: typeof info.commit === 'string' && /^[a-f0-9]{40}$/i.test(info.commit) ? info.commit : null,
      dirty: typeof info.dirty === 'boolean' ? info.dirty : null,
    };
  } catch { /* Legacy or mismatched artifact: identity is unknown. */ }
  return {sha256,commit:null,dirty:null};
}

/** GET a URL; resolves with the status code, or 0 when nothing answered in time. */
function probe(host, port, path, timeoutMs = 5000) {
  return new Promise((done) => {
    const req = httpRequest({ host, port, path, method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(0));
    req.end();
  });
}

/** Is anything accepting TCP connections on host:port? */
function portInUse(host, port) {
  return new Promise((done) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => { socket.destroy(); done(true); });
    socket.once('timeout', () => { socket.destroy(); done(false); });
    socket.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Supervisor {
  constructor(settings, { env = process.env, out = process.stdout } = {}) {
    this.s = settings;
    this.env = env;
    this.out = out;
    this.token = ensureToken(settings, env);
    this.mode = 'starting';
    this.build = 'current';
    this.reason = null;
    this.since = new Date().toISOString();
    this.failures = 0;
    this.attempts = [];
    this.child = null;
    this.childExit = null;
    this.logRing = [];
    this.servers = [];
    this.stopping = false;
    this.busy = false;
    this.lastOperatorAt = 0;
    this.retryIndex = 0;
    this.retryTimer = null;
    this.bindTimer = null;
    this.stableTimer = null;
    this.healthTimer = null;
    this.lastGood = this.readLastGoodMeta();
    this.checkoutCommit = gitCommit(settings.projectDir);
    this.artifact = readBuildIdentity(settings.entry);
    this.commit = this.artifact.commit;
  }

  log(level, msg, extra = {}) {
    const levels = { info: 30, warn: 40, error: 50 };
    const line = JSON.stringify({ level: levels[level] ?? 30, time: Date.now(), name: 'supervisor', msg, ...extra });
    this.pushLog(line);
    try {
      this.out.write(`${line}\n`);
    } catch {
      // stdout gone (terminal closed); keep supervising.
    }
  }

  pushLog(line) {
    this.logRing.push(line);
    if (this.logRing.length > LOG_RING_LINES) this.logRing.splice(0, this.logRing.length - LOG_RING_LINES);
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  setMode(mode, reason = null) {
    this.mode = mode;
    this.reason = reason;
    this.since = new Date().toISOString();
    this.writeState();
  }

  snapshot() {
    return {
      pid: process.pid,
      mode: this.mode,
      reason: this.reason,
      since: this.since,
      build: this.build,
      backendPid: this.child?.pid ?? null,
      port: this.s.port,
      recoveryPorts: this.servers.map((srv) => srv.address()?.port).filter(Boolean),
      consecutiveFailures: this.failures,
      attempts: this.attempts.slice(-10),
      lastGood: this.lastGood,
      commit: this.commit,
      checkoutCommit: this.checkoutCommit,
      artifactSha256: this.artifact.sha256,
      buildDirty: this.artifact.dirty,
      nextAutoRetryAt: this.retryAt ?? null,
    };
  }

  writeState() {
    try {
      mkdirSync(this.s.stateDir, { recursive: true });
      const tmp = `${this.s.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
      renameSync(tmp, this.s.stateFile);
    } catch (err) {
      this.out.write(`supervisor: could not write ${this.s.stateFile}: ${err.message}\n`);
    }
  }

  readLastGoodMeta() {
    try {
      return JSON.parse(readFileSync(join(this.s.lastGoodDir, 'build.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  lastGoodAvailable() {
    const entry = join(this.s.lastGoodDir, 'index.js');
    if (!existsSync(entry)) return false;
    return sha256File(entry) !== sha256File(this.s.entry);
  }

  /** Keep a copy of a build that booted and stayed up, to fall back to. */
  saveLastGood() {
    if (this.build !== 'current') return;
    const hash = sha256File(this.s.entry);
    if (!hash || hash === this.lastGood?.sha256) return;
    const srcDir = dirname(this.s.entry);
    const tmp = `${this.s.lastGoodDir}.tmp`;
    try {
      rmSync(tmp, { recursive: true, force: true });
      cpSync(srcDir, tmp, { recursive: true });
      const meta = { sha256: hash, commit: this.commit, savedAt: new Date().toISOString() };
      writeFileSync(join(tmp, 'build.json'), JSON.stringify(meta, null, 2));
      rmSync(this.s.lastGoodDir, { recursive: true, force: true });
      renameSync(tmp, this.s.lastGoodDir);
      this.lastGood = meta;
      this.log('info', 'Saved this build as the last good build', meta);
      this.writeState();
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      this.log('warn', `Could not save the last good build: ${err.message}`);
    }
  }

  // ─── Backend lifecycle ──────────────────────────────────────────────────────

  entryFor(build) {
    return build === 'last-good' ? join(this.s.lastGoodDir, 'index.js') : this.s.entry;
  }

  spawnBackend(build) {
    const entry = this.entryFor(build);
    const env = {
      ...this.env,
      PATH: `${join(this.s.projectDir, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${this.env.PATH ?? ''}`,
      OCTIPUS_SUPERVISED: '1',
      OCTIPUS_INSIDE_PID: String(process.pid),
    };
    delete env.OCTIPUS_RECOVERY_TOKEN;
    const child = spawn(process.execPath, [entry], { cwd: this.s.projectDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (stream, sink) => {
      let partial = '';
      stream.on('data', (chunk) => {
        try {
          sink.write(chunk);
        } catch {
          // Our stdout is gone; the ring buffer still has it.
        }
        const text = partial + chunk.toString('utf8');
        const lines = text.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) if (line) this.pushLog(line);
      });
    };
    relay(child.stdout, this.out);
    relay(child.stderr, this.out);
    this.child = child;
    child.exited = new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })));
    this.childExit = child.exited;
    child.once('error', (err) => this.log('error', `Could not start the backend: ${err.message}`));
    return child;
  }

  /**
   * Stop `child` (the current backend by default). Six seconds before SIGKILL:
   * the backend force-exits after four, and `octi stop` waits ten for us.
   */
  async killChild(child = this.child, graceMs = 6000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const exited = await Promise.race([child.exited.then(() => true), sleep(graceMs).then(() => false)]);
    if (!exited) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }

  /** Start the backend and wait until it is healthy. Resolves true, or false having recorded why not. */
  async boot(build) {
    await this.closeRecoveryServers();
    this.build = build;
    this.setMode('starting', build === 'last-good' ? 'Starting the last good build' : null);
    const startedAt = Date.now();
    const attempt = { startedAt: new Date(startedAt).toISOString(), build, outcome: 'starting' };
    this.attempts.push(attempt);
    this.checkoutCommit = gitCommit(this.s.projectDir);
    this.artifact = readBuildIdentity(this.entryFor(build));
    this.commit = this.artifact.commit;
    if (!existsSync(this.entryFor(build))) {
      attempt.outcome = 'missing-build';
      attempt.detail = `${this.entryFor(build)} does not exist (run npm run build)`;
      this.log('error', `Backend build missing: ${attempt.detail}`);
      return false;
    }
    // Whatever answers /api/health below has to be the child we start, so the
    // port must be free first. A previous backend still shutting down gets a
    // little while; one that stays is a failed attempt, not a healthy boot.
    const host = probeHost(this.s.host);
    const portFreeBy = Date.now() + this.s.portWaitMs;
    while (await portInUse(host, this.s.port)) {
      if (this.stopping) return false;
      if (Date.now() > portFreeBy) {
        attempt.outcome = 'port-in-use';
        attempt.detail = `Something else is listening on port ${this.s.port}`;
        attempt.endedAt = new Date().toISOString();
        this.log('error', `Port ${this.s.port} is still taken by another process — not starting the backend`);
        return false;
      }
      await sleep(500);
    }
    this.log('info', `Starting backend (${build} build)`);
    const logStart = this.logRing.length;
    const child = this.spawnBackend(build);
    const deadline = startedAt + this.s.bootTimeoutMs;
    let exited = null;
    void child.exited.then((e) => { exited = e; });
    while (Date.now() < deadline) {
      if (this.stopping) return false;
      if (exited) break;
      if ((await probe(host, this.s.port, '/api/health', 3000)) === 200) {
        // The port was free when it started, so the answer is this child's.
        if (!exited && this.child === child) {
          attempt.outcome = 'healthy';
          attempt.bootMs = Date.now() - startedAt;
          this.setMode('running');
          this.log('info', `Backend is up (${build} build, ${attempt.bootMs} ms)`);
          return true;
        }
      }
      await sleep(1000);
    }
    if (!exited) {
      attempt.outcome = 'boot-timeout';
      this.log('error', `Backend did not answer /api/health within ${this.s.bootTimeoutMs} ms — stopping it`);
      await this.killChild(child);
    } else {
      attempt.outcome = 'crashed';
    }
    const ended = exited ?? (await child.exited);
    attempt.exitCode = ended.code;
    attempt.signal = ended.signal;
    attempt.endedAt = new Date().toISOString();
    attempt.logTail = this.logRing.slice(Math.max(logStart, this.logRing.length - 40));
    this.child = null;
    return false;
  }

  /** While running: restart on a crash or a hang, remember a build that stays up. */
  watch() {
    const child = this.child;
    let missed = 0;
    let stable = false;
    this.stableTimer = setTimeout(() => {
      stable = true;
      this.failures = 0;
      this.saveLastGood();
      this.writeState();
    }, this.s.stableMs);
    this.healthTimer = setInterval(async () => {
      if (this.child !== child || this.stopping) return;
      const status = await probe(probeHost(this.s.host), this.s.port, '/api/health', 5000);
      // The probe took a while: this child may have exited and been replaced
      // since. Its result says nothing about the new one.
      if (this.child !== child || this.stopping) return;
      missed = status === 200 ? 0 : missed + 1;
      if (missed >= this.s.hangChecks) {
        this.log('error', `Backend missed ${missed} health checks in a row — restarting it`);
        missed = 0;
        await this.killChild(child);
      }
    }, this.s.healthIntervalMs);
    void child.exited.then(({ code, signal }) => {
      clearTimeout(this.stableTimer);
      clearInterval(this.healthTimer);
      if (this.stopping || this.child !== child) return;
      this.child = null;
      this.attempts.push({ startedAt: new Date().toISOString(), build: this.build, outcome: 'exited-while-running', exitCode: code, signal, logTail: this.logRing.slice(-40) });
      this.log('error', `Backend exited while running (code ${code}, signal ${signal}) — restarting`);
      if (stable) {
        // It ran fine for a while: a crash, not a build that cannot run. Start
        // it again straight away; the ladder applies if that boot fails.
        void sleep(1000).then(() => this.run(this.build));
        return;
      }
      this.failures += 1;
      void this.afterFailure();
    });
  }

  async afterFailure() {
    if (this.stopping) return;
    const step = nextStep({ failures: this.failures, build: this.build, lastGoodAvailable: this.lastGoodAvailable(), maxRetries: this.s.maxRetries });
    if (step.action === 'recovery') {
      await this.enterRecovery(`Backend failed to start ${this.failures} time(s) in a row`);
      return;
    }
    if (step.build === 'last-good' && this.build !== 'last-good') {
      this.log('warn', 'Current build keeps failing — falling back to the last good build', { lastGood: this.lastGood });
    }
    await sleep(step.delayMs);
    await this.run(step.build);
  }

  /** Boot, and on success watch; on failure walk the repair ladder. */
  async run(build = 'current') {
    if (this.stopping) return;
    if (await this.boot(build)) {
      this.watch();
      return;
    }
    if (this.stopping) return;
    this.failures += 1;
    await this.afterFailure();
  }

  // ─── Recovery mode ──────────────────────────────────────────────────────────

  async enterRecovery(reason) {
    this.log('error', `Entering recovery mode: ${reason}`);
    this.setMode('recovery', reason);
    await this.openRecoveryServers();
    this.scheduleAutoRetry();
  }

  scheduleAutoRetry() {
    clearTimeout(this.retryTimer);
    const delay = RECOVERY_RETRY_MS[Math.min(this.retryIndex, RECOVERY_RETRY_MS.length - 1)];
    this.retryAt = new Date(Date.now() + delay).toISOString();
    this.writeState();
    // Not unref'd: when the recovery server could not bind, this timer is
    // what keeps the supervisor alive to try again.
    this.retryTimer = setTimeout(() => void this.autoRetry(), delay);
  }

  async autoRetry() {
    if (this.mode !== 'recovery' || this.stopping) return;
    if (this.busy || Date.now() - this.lastOperatorAt < OPERATOR_QUIET_MS) {
      this.retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
      this.writeState();
      this.retryTimer = setTimeout(() => void this.autoRetry(), 5 * 60_000);
      return;
    }
    this.retryIndex += 1;
    this.retryAt = null;
    this.log('info', 'Recovery mode: trying the backend again');
    await this.singleAttempt('current');
  }

  /** One boot attempt from recovery mode; back to recovery when it fails. */
  async singleAttempt(build) {
    this.busy = true;
    try {
      if (await this.boot(build)) {
        this.failures = 0;
        this.retryIndex = 0;
        this.watch();
        return true;
      }
      if (!this.stopping) await this.enterRecovery(`Retry with the ${build} build failed`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  async openRecoveryServers() {
    clearTimeout(this.bindTimer);
    const bound = new Set(this.servers.map((srv) => srv.address()?.port));
    const ports = [this.s.port];
    if (this.s.webPort && this.s.webPort !== this.s.port) ports.push(this.s.webPort);
    for (const port of ports) {
      if (bound.has(port)) continue;
      if (this.mode !== 'recovery' || this.stopping) return;
      const required = port === this.s.port;
      const giveUpAt = Date.now() + (required ? this.s.portWaitMs : 0);
      while (true) {
        try {
          const server = await this.listen(port);
          this.servers.push(server);
          this.log('info', `Recovery server listening on ${this.s.host}:${port}`);
          break;
        } catch (err) {
          // The web port is optional: whoever has it (the web UI) proxies /api here anyway.
          if (!required || Date.now() >= giveUpAt || this.stopping) break;
          this.log('warn', `Recovery server could not bind port ${port}: ${err.message} — retrying`);
          await sleep(Math.min(5000, this.s.portWaitMs));
        }
      }
    }
    // Still without the API port: keep trying in the background, so recovery
    // mode appears as soon as whatever holds it lets go.
    if (!this.servers.some((srv) => srv.address()?.port === this.s.port)) {
      this.log('error', `Recovery server could not bind port ${this.s.port} — trying again in ${Math.round(this.s.portWaitMs / 1000)} s`);
      this.bindTimer = setTimeout(() => void this.openRecoveryServers(), this.s.portWaitMs);
    }
    this.writeState();
  }

  listen(port) {
    return new Promise((done, fail) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          if (!res.headersSent) sendJson(res, 500, { error: err.message });
          else res.end();
        });
      });
      server.once('error', fail);
      server.listen(port, this.s.host, () => {
        server.off('error', fail);
        done(server);
      });
    });
  }

  async closeRecoveryServers() {
    const servers = this.servers;
    this.servers = [];
    clearTimeout(this.retryTimer);
    clearTimeout(this.bindTimer);
    this.retryAt = null;
    await Promise.all(servers.map((srv) => new Promise((done) => {
      srv.close(() => done());
      srv.closeAllConnections?.();
    })));
  }

  authorized(req) {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const presented = bearer || String(req.headers['x-recovery-token'] ?? '');
    return tokenMatches(this.token, presented);
  }

  async handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://recovery.local');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Public: enough for a launcher, a load balancer or a person to see what is going on.
    if (path === '/api/health' || path.startsWith('/api/health/')) {
      return sendJson(res, 503, { status: 'recovery', mode: this.mode, reason: this.reason, since: this.since, recovery: '/api/recovery' });
    }
    if (req.method === 'GET' && (path === '/' || path === '/api/recovery' || path === '/recovery')) {
      return sendHtml(res, recoveryPage());
    }
    if (!path.startsWith('/api/recovery/')) return sendJson(res, 404, { error: 'Octipus is in recovery mode', recovery: '/api/recovery' });

    if (!this.authorized(req)) {
      await sleep(250);
      return sendJson(res, 401, { error: 'Recovery token required (Authorization: Bearer <token>)' });
    }
    this.lastOperatorAt = Date.now();
    const action = path.slice('/api/recovery/'.length);

    if (req.method === 'GET' && action === 'status') return sendJson(res, 200, this.snapshot());
    if (req.method === 'GET' && action === 'logs') {
      const lines = Math.min(num(url.searchParams.get('lines'), 200), LOG_RING_LINES);
      const buildLog = readTail(join(this.s.stateDir, 'backend.log.build'), 60);
      return sendJson(res, 200, { lines: this.logRing.slice(-lines), buildLog });
    }
    if (req.method === 'POST' && action === 'restart') {
      const body = await readJson(req);
      const build = body.build === 'last-good' ? 'last-good' : 'current';
      if (build === 'last-good' && !existsSync(join(this.s.lastGoodDir, 'index.js'))) return sendJson(res, 409, { error: 'No last good build saved yet' });
      if (this.busy) return sendJson(res, 409, { error: 'A restart is already in progress' });
      this.busy = true;
      sendJson(res, 202, { accepted: true, build, rebuild: !!body.rebuild, hint: 'Poll GET /api/health: 200 when the backend is back, 503 with mode "recovery" if it failed again' });
      setTimeout(async () => {
        try {
          if (body.rebuild) {
            this.log('info', 'Recovery: rebuilding the backend');
            const result = await runCommand('npm run build', { cwd: this.s.projectDir, timeoutMs: 15 * 60_000, env: this.buildEnv() });
            for (const line of `${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`.split('\n')) if (line) this.pushLog(line);
            this.log(result.code === 0 ? 'info' : 'error', `Rebuild exited with code ${result.code}`);
            if (result.code !== 0) {
              this.log('error', 'Rebuild failed — staying in recovery mode');
              return;
            }
          }
          // singleAttempt keeps `busy` set until the boot is decided.
          await this.singleAttempt(build);
        } finally {
          this.busy = false;
        }
      }, 100);
      return;
    }
    return sendJson(res, 404, { error: `Unknown recovery action: ${req.method} ${action}` });
  }

  /** Environment for the rebuild: no credentials, and marked as running under the supervisor. */
  buildEnv() {
    const env = {};
    for (const [k, v] of Object.entries(this.env)) if (v !== undefined && !SENSITIVE_ENV.test(k)) env[k] = v;
    env.OCTIPUS_INSIDE_PID = String(process.pid);
    return env;
  }

  // ─── Process lifecycle ──────────────────────────────────────────────────────

  async start() {
    this.log('info', 'Supervisor started', { pid: process.pid, port: this.s.port, tokenFile: this.env.OCTIPUS_RECOVERY_TOKEN ? '(environment)' : this.s.tokenFile });
    this.writeState();
    await this.run('current');
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.setMode('stopping');
    clearTimeout(this.stableTimer);
    clearInterval(this.healthTimer);
    clearTimeout(this.retryTimer);
    await this.closeRecoveryServers();
    await this.killChild();
    try {
      rmSync(this.s.stateFile, { force: true });
    } catch {
      // Nothing to clean.
    }
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendHtml(res, html) {
  res.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(html);
}

function readJson(req) {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return done({});
      try {
        const parsed = JSON.parse(text);
        done(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        fail(new Error('Body is not valid JSON'));
      }
    });
    req.on('error', fail);
  });
}

function readTail(path, lines) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Run one of the supervisor's own fixed commands (the rebuild) in its own
 * process group, with a deadline and capped output. Never a caller-supplied
 * command.
 */
export function runCommand(command, { cwd, timeoutMs, env }) {
  return new Promise((done) => {
    const windows = process.platform === 'win32';
    const shell = windows ? 'cmd.exe' : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
    const args = windows ? ['/d', '/s', '/c', command] : ['-c', command];
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(shell, args, { cwd, env, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const cap = (acc, chunk) => (acc.length >= MAX_EXEC_OUTPUT ? acc : (acc + chunk.toString('utf8')).slice(0, MAX_EXEC_OUTPUT));
    child.stdout.on('data', (c) => { stdout = cap(stdout, c); });
    child.stderr.on('data', (c) => { stderr = cap(stderr, c); });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (windows) child.kill();
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: 127, signal: null, stdout, stderr: `${stderr}${err.message}`, timedOut, durationMs: Date.now() - startedAt });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });
  });
}

function recoveryPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Octipus recovery</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--muted:#666;--line:#ddd;--accent:#b4541a}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#999;--line:#333;--accent:#f08a4b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0}p{color:var(--muted)}
input,textarea,button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:6px;padding:8px}
input,textarea{width:100%;box-sizing:border-box}
button{cursor:pointer;margin:4px 4px 4px 0}button.primary{border-color:var(--accent);color:var(--accent)}
pre{white-space:pre-wrap;word-break:break-word;border:1px solid var(--line);border-radius:6px;padding:8px;max-height:60vh;overflow:auto;font-size:12px}
</style></head><body><main>
<h1>Octipus is in recovery mode</h1>
<p>The backend failed to start. This page runs from the supervisor, without the backend. Enter the recovery token (<code>octi recovery</code> prints it; it lives in <code>~/.octipus/recovery-token</code>).</p>
<input id="token" type="password" placeholder="Recovery token" autocomplete="off">
<div>
<button id="status">Status</button><button id="logs">Logs</button>
<button id="restart" class="primary">Retry</button><button id="rebuild">Rebuild &amp; retry</button><button id="lastgood">Start last good build</button>
</div>
<pre id="out">Health: /api/health · API: /api/recovery/{status,logs,restart}</pre>
</main><script>
const $=(id)=>document.getElementById(id);
try{$('token').value=sessionStorage.getItem('octi-recovery-token')||''}catch{}
$('token').addEventListener('change',()=>{try{sessionStorage.setItem('octi-recovery-token',$('token').value)}catch{}});
async function call(method,path,body){
  $('out').textContent='…';
  try{
    const r=await fetch('/api/recovery/'+path,{method,headers:{authorization:'Bearer '+$('token').value,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
    const j=await r.json();
    if(path.startsWith('logs')&&j.lines){$('out').textContent=j.lines.join('\\n');return}
    $('out').textContent=JSON.stringify(j,null,2);
  }catch(e){$('out').textContent=String(e)}
}
$('status').onclick=()=>call('GET','status');
$('logs').onclick=()=>call('GET','logs?lines=300');
$('restart').onclick=()=>call('POST','restart',{});
$('rebuild').onclick=()=>call('POST','restart',{rebuild:true});
$('lastgood').onclick=()=>call('POST','restart',{build:'last-good'});
</script></body></html>`;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  const supervisor = new Supervisor(resolveSettings());
  const shutdown = async () => {
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', () => {}); // Outlive the terminal or session that started us.
  process.on('uncaughtException', (err) => supervisor.log('error', `Supervisor error (kept running): ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (err) => supervisor.log('error', `Supervisor error (kept running): ${err?.stack ?? err}`));
  await supervisor.start();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

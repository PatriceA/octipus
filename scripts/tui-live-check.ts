#!/usr/bin/env tsx
/**
 * Live TUI check — the terminal client, driven through a real pty.
 *
 * The TUI has unit tests for its renderers and its gateway adapter, and none
 * of them answer whether a person can open the terminal client and get a
 * reply. This does: it launches the shipped entry point under a pty, types a
 * question whose answer changes every run, and waits for that answer to appear
 * in what the terminal actually painted.
 *
 * A pty is required rather than a plain pipe — pi-tui only renders when stdout
 * is a TTY, so piping gives an empty transcript and a green check for nothing.
 *
 * Usage:
 *   npx tsx scripts/tui-live-check.ts [--timeout 180000] [--json out.json]
 */
import { spawn } from 'node:child_process';
import { writeFileAt } from '@/utils/fs-file';

const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const TIMEOUT_MS = Number(arg('timeout') ?? 180_000);
const JSON_OUT = arg('json');

/** Strip the escape sequences so assertions read the text a human sees. */
const plain = (s: string): string =>
  s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');

interface Step { step: string; ms: number; ok: boolean; detail?: string }

async function main(): Promise<void> {
  const steps: Step[] = [];
  const a = 100 + Math.floor(Math.random() * 800);
  const b = 100 + Math.floor(Math.random() * 800);
  const expected = String(a + b);

  let out = '';
  const started = Date.now();
  // `script` gives the child a pty; -q quiet, -e propagate exit code, -c command.
  const child = spawn('script', ['-qec', 'npx tsx --import ./scripts/md-loader.mjs src/tui-pi/index.ts', '/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { out += d.toString(); });

  const waitFor = (needle: string, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      const deadline = Date.now() + ms;
      const tick = setInterval(() => {
        if (plain(out).includes(needle)) { clearInterval(tick); resolve(true); }
        else if (Date.now() > deadline) { clearInterval(tick); resolve(false); }
      }, 200);
    });

  const record = async (step: string, fn: () => Promise<boolean>): Promise<boolean> => {
    const t0 = Date.now();
    const ok = await fn();
    steps.push({ step, ms: Date.now() - t0, ok });
    return ok;
  };

  const booted = await record('tui boots and connects', () => waitFor('connected', 30_000));

  let answered = false;
  if (booted) {
    // Typed the way a person types it: characters, then Enter.
    child.stdin.write(`What is ${a} plus ${b}? Reply with only the number.`);
    await new Promise((r) => setTimeout(r, 300));
    answered = await record('answer appears in the terminal', async () => {
      child.stdin.write('\r');
      return waitFor(expected, TIMEOUT_MS);
    });
  }

  let helped = false;
  let tooled = false;
  if (booted) {
    helped = await record('slash command renders', async () => {
      child.stdin.write('/help\r');
      // `/help` is served by the gateway and lists the commands it owns.
      return waitFor('/compact', 20_000);
    });

    tooled = await record('a tool-backed answer comes back', async () => {
      // The expected string must appear ONLY in the answer: a marker the user
      // types is echoed by the composer and again in the transcript, so
      // "appears twice" is satisfied before the model has done anything. The
      // product of the multiplication is nowhere in the question.
      const x = 300 + Math.floor(Math.random() * 300);
      const product = String(x * 7);
      child.stdin.write(`Run the shell command: echo $((${x} * 7)) — then tell me exactly what it printed.`);
      await new Promise((r) => setTimeout(r, 300));
      child.stdin.write('\r');
      return waitFor(product, TIMEOUT_MS);
    });
  }
  void helped;
  void tooled;

  child.stdin.write('\x03');
  await new Promise((r) => setTimeout(r, 500));
  child.kill('SIGKILL');

  const failed = steps.filter((s) => !s.ok);
  console.log(`\ntui-live-check  (asked ${a} + ${b} = ${expected})\n`);
  for (const s of steps) {
    console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${String(s.ms).padStart(6)}ms  ${s.step}`);
  }
  console.log(`\n  ${steps.length - failed.length}/${steps.length} steps · ${((Date.now() - started) / 1000).toFixed(1)}s total`);

  if (!answered) {
    const tail = plain(out).split('\n').filter((l) => l.trim()).slice(-12).join('\n    ');
    console.log(`\n  last painted lines:\n    ${tail}`);
  }

  if (JSON_OUT) {
    await writeFileAt(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), asked: `${a}+${b}`, steps }, null, 2));
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();

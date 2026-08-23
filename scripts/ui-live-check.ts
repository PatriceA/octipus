#!/usr/bin/env tsx
/**
 * Live web-UI check — the real browser, the real web app, the real backend.
 *
 * The Playwright suite under `tests/web` stubs every `/api/**` call at the
 * browser, which is right for testing the front-end and useless for answering
 * "does the product work". This drives the shipped UI against a running
 * instance: it logs in, walks the main pages, sends a chat message, and waits
 * for the answer to appear on screen — measuring what the user waits for
 * rather than what the API returns.
 *
 * Usage:
 *   npx tsx scripts/ui-live-check.ts --user <name> --pass <password>
 *        [--base http://localhost:3007] [--json out.json] [--shots dir]
 */
import { chromium, type Page } from 'playwright';
import { writeFileAt } from '@/utils/fs-file';

const args = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const BASE = arg('base') ?? 'http://localhost:3007';
const USER = arg('user');
const PASS = arg('pass');
const JSON_OUT = arg('json');
const SHOTS = arg('shots');
const HEADED = args.includes('--headed');

if (!USER || !PASS) {
  console.error('ui-live-check: --user and --pass are required');
  process.exit(2);
}

interface Step {
  step: string;
  ms: number;
  ok: boolean;
  detail?: string;
}

const steps: Step[] = [];
const record = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
  const started = Date.now();
  try {
    const out = await fn();
    steps.push({ step: name, ms: Date.now() - started, ok: true });
    return out;
  } catch (err) {
    steps.push({
      step: name,
      ms: Date.now() - started,
      ok: false,
      detail: err instanceof Error ? err.message.split('\n')[0] : String(err),
    });
    return null;
  }
};

/** Pages the product's navigation offers, and what proves each one rendered. */
const PAGES: Array<{ path: string; proof: string }> = [
  // Proofs are page-specific text or controls rather than `main`: the app's
  // shell does not use a <main> landmark, so waiting for one proved nothing on
  // the pages that have it and hung 20s on the pages that do not.
  { path: '/chat', proof: 'text=sessions' },
  { path: '/models', proof: 'text=/models/i' },
  { path: '/knowledge', proof: 'text=/knowledge/i' },
  { path: '/pipelines', proof: 'text=/pipeline/i' },
  { path: '/notes', proof: 'text=/note/i' },
  { path: '/agents', proof: 'text=/agent/i' },
  { path: '/settings', proof: 'text=/general/i' },
];

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }).catch(() => {});
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: !HEADED });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleErrors: string[] = [];
  /** Which request failed, not just that one did — a bare console line names nothing. */
  const httpFailures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) httpFailures.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));

  await record('login page loads', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="password"]', { timeout: 20_000 });
    await shot(page, '01-login');
  });

  await record('login succeeds', async () => {
    await page.fill('input[placeholder="alice"]', USER!);
    await page.fill('input[type="password"]', PASS!);
    await page.click('button[type="submit"]');
    // Landing anywhere off /login means the session cookie was accepted.
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });
    await shot(page, '02-after-login');
  });

  for (const p of PAGES) {
    await record(`page ${p.path}`, async () => {
      await page.goto(`${BASE}${p.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(p.proof, { timeout: 20_000 });
      await shot(page, `page${p.path.replace(/\//g, '-')}`);
      // The API rate-limits per user; hammering seven pages back to back
      // measures the limiter rather than the app.
      await page.waitForTimeout(400);
    });
  }

  // The measurement that matters: a real turn, timed from pressing enter to
  // the answer being on screen — not to the API returning.
  await record('create a chat session', async () => {
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=sessions', { timeout: 20_000 });
    // ALWAYS a new session, never a reused one. Reusing meant the transcript
    // already held an answer from the last run, and the assertion below matched
    // it instantly — a green check for a turn that never happened.
    await page.getByText('new', { exact: true }).first().click();
    // `new` opens a mode dialog; the session only exists once it is confirmed.
    // Skipping that left the dialog open over a composer the run then typed
    // into — it worked, and it was not what a user does.
    const confirm = page.getByRole('button', { name: /create session/i });
    await confirm.waitFor({ timeout: 15_000 });
    await confirm.click();
    await page.waitForSelector('textarea:not([disabled])', { timeout: 30_000 });
    await page.waitForSelector('text=/create session/i', { state: 'detached', timeout: 15_000 });
  });

  await record('chat turn end to end', async () => {
    const box = page.locator('textarea:not([disabled])').first();
    await box.waitFor({ timeout: 20_000 });
    // A different sum every run, so a stale transcript cannot answer for the
    // model. The two mistakes an assertion like this can make are not equal:
    // a false green here says the product replies when it does not.
    const a = 100 + Math.floor(Math.random() * 800);
    const b = 100 + Math.floor(Math.random() * 800);
    await box.fill(`What is ${a} plus ${b}? Reply with only the number.`);
    await box.press('Enter');
    // Waits for an ASSISTANT bubble carrying the answer. Matching page text
    // would have matched the question the moment it was echoed into the
    // transcript — which is how an earlier version of this check "passed" in
    // 206ms without a model ever replying.
    await page.waitForSelector(`[data-role="assistant"]:has-text("${a + b}")`, { timeout: 180_000 });
    await shot(page, '03-chat-answer');
  });

  const failed = steps.filter((s) => !s.ok);
  const total = steps.reduce((t, s) => t + s.ms, 0);

  console.log(`\nui-live-check → ${BASE}\n`);
  for (const s of steps) {
    console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${String(s.ms).padStart(6)}ms  ${s.step}${s.detail ? `  [${s.detail}]` : ''}`);
  }
  console.log(`\n  ${steps.length - failed.length}/${steps.length} steps · ${(total / 1000).toFixed(1)}s total`);
  if (httpFailures.length > 0) {
    const counted = new Map<string, number>();
    for (const f of httpFailures) counted.set(f, (counted.get(f) ?? 0) + 1);
    console.log(`\n  failed requests (${httpFailures.length}):`);
    for (const [f, n] of [...counted.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`    ${String(n).padStart(3)}×  ${f}`);
    }
  }
  if (consoleErrors.length > 0) {
    console.log(`\n  console errors (${consoleErrors.length}):`);
    for (const e of [...new Set(consoleErrors)].slice(0, 6)) console.log(`    ${e}`);
  }

  if (JSON_OUT) {
    await writeFileAt(JSON_OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), steps, httpFailures, consoleErrors }, null, 2));
  }

  await browser.close();
  process.exit(failed.length > 0 ? 1 : 0);
}

void main();

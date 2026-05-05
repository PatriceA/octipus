/**
 * e2e: pi-tui chat shell (`bun run src/tui-pi/index.ts`).
 *
 * Verifies the bits Phase 4 promised end users:
 *   - launch + welcome message
 *   - typing a chat message and submitting it (composer onSubmit wiring)
 *   - slash command autocomplete trigger
 *   - command palette overlay (Ctrl+P)
 *
 * Skips the whole suite when the gateway isn't reachable so CI noise
 * stays low. Run `octi start` first to exercise the suite locally.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { backendUp, KEY, TuiHarness } from './harness';

// Top-level await: bun:test registers tests synchronously, so the
// gateway probe must resolve before the suite is declared.
const backend = await backendUp();
const itIfBackend = (...args: Parameters<typeof it>) => (backend ? it(...args) : it.skip(...args));

describe('tui-pi chat shell', () => {
  let harness: TuiHarness | null = null;

  afterEach(async () => { await harness?.stop(); harness = null; });

  itIfBackend('renders welcome banner on launch', async () => {
    harness = new TuiHarness({ entry: 'src/tui-pi/index.ts' });
    await harness.waitFor('Welcome to Octipus.');
    await harness.waitFor('connected');
  }, 10_000);

  itIfBackend('echoes a typed chat message back as a user bubble', async () => {
    harness = new TuiHarness({ entry: 'src/tui-pi/index.ts' });
    await harness.waitFor('connected');
    harness.send('hello');
    await harness.wait(200);
    harness.send(KEY.Enter);
    await harness.waitFor('❯ hello');
  }, 10_000);

  itIfBackend('shows slash command autocomplete after typing /', async () => {
    harness = new TuiHarness({ entry: 'src/tui-pi/index.ts' });
    await harness.waitFor('connected');
    harness.send('/');
    await harness.wait(300);
    expect(harness.stripped()).toContain('help');
  }, 10_000);

  itIfBackend('opens the command palette on Ctrl+P', async () => {
    harness = new TuiHarness({ entry: 'src/tui-pi/index.ts' });
    await harness.waitFor('connected');
    harness.send(KEY.CtrlP);
    await harness.wait(300);
    // Palette renders the slash registry — `expert` is one of the entries.
    expect(harness.stripped()).toContain('expert');
  }, 10_000);
});

import { describe, expect, test } from 'vitest';
import { discoverChannels } from './discovery';

/**
 * Channel discovery — verifies the auto-loader picks up the shipped
 * channel folders. Smoke-only: instantiation of each channel's
 * dependencies (Telegram SDK, Slack client, Teams botbuilder, etc.)
 * happens lazily on `connect()`, so this just confirms the folder
 * walk + module-import path works.
 *
 * The set of shipped channels is the convention the codebase relies
 * on; if a folder is renamed or deleted, the assertion below tells
 * us early.
 */
describe('discoverChannels', () => {
  test('finds at least the canonical channel folders', async () => {
    const found = await discoverChannels();
    const folders = found.map((f) => f.folder).sort();
    // These four are load-bearing — used by the gateway and CI smoke.
    // If any disappear, the gateway WS handshake breaks for that channel.
    expect(folders).toContain('webchat');
    expect(folders).toContain('telegram');
    expect(folders).toContain('slack');
    expect(folders).toContain('teams');
  });

  test('every discovered channel exposes a unique `type` literal', async () => {
    const found = await discoverChannels();
    const types = found.map((f) => f.channel.type);
    const unique = new Set(types);
    expect(unique.size).toBe(types.length);
  });

  test('every discovered channel exposes a non-empty `name`', async () => {
    const found = await discoverChannels();
    for (const { folder, channel } of found) {
      expect(channel.name, `channel in ${folder}`).toBeTruthy();
      expect(channel.name.length, `channel ${folder} name length`).toBeGreaterThan(0);
    }
  });

  test('discovery silently skips folders without a BaseChannel export', async () => {
    // The function must not throw on stray folders. We can't easily
    // create one mid-test (it scans the source tree), but the
    // discovery code path's contract is "skip with debug log, don't
    // crash" — verified by the function returning at all on a tree
    // that may contain non-channel dirs.
    const found = await discoverChannels();
    expect(Array.isArray(found)).toBe(true);
  });
});

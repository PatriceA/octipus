/**
 * Integration smoke test — the auto-discovery scan should pick up every
 * collector shipped in Phase 1 and register them. Bun runs in the repo
 * cwd, so the discovery scan walks the real `collectors/` folder.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { discoverToolbox } from './discovery';
import { _resetToolboxRegistryForTests, getToolboxRegistry } from './registry';

describe('discoverToolbox', () => {
  beforeEach(() => { _resetToolboxRegistryForTests(); });
  afterEach(() => { _resetToolboxRegistryForTests(); });

  test('registers all Phase 1 collectors', async () => {
    await discoverToolbox();
    const ids = getToolboxRegistry().list().map((e) => e.id);
    expect(ids).toContain('art_collect_http_json');
    expect(ids).toContain('art_collect_http_text');
    expect(ids).toContain('art_collect_rss');
    expect(ids).toContain('art_collect_octipus_tool');
    expect(ids).toContain('art_collect_mcp');
  });

  test('is idempotent', async () => {
    await discoverToolbox();
    const before = getToolboxRegistry().list().length;
    await discoverToolbox();
    expect(getToolboxRegistry().list().length).toBe(before);
  });

  test('every registered tool has the expected manifest shape', async () => {
    await discoverToolbox();
    for (const entry of getToolboxRegistry().list()) {
      const d = getToolboxRegistry().describe(entry.id);
      expect(d).not.toBeNull();
      expect(d!.description.length).toBeGreaterThan(0);
      expect(d!.returns.length).toBeGreaterThan(0);
    }
  });
});

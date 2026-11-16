import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMuseModels, museCatalogDir } from './muse-cli-models';

const row = (id: string, visibility: string, isDefault = false) => ({ model_id: id, display_label: `L ${id}`, visibility, is_default: isDefault });

describe('discoverMuseModels', () => {
  it('lists visible rows of the newest catalog, flags the default', async () => {
    const env = { XDG_DATA_HOME: mkdtempSync(join(tmpdir(), 'muse-cat-')) };
    const dir = museCatalogDir(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ rows: [row('stale', 'visible')] }));
    utimesSync(join(dir, 'old.json'), 1, 1);
    writeFileSync(join(dir, 'new.json'), JSON.stringify({ rows: [row('a', 'visible', true), row('a-hidden', 'hidden'), row('b', 'visible')] }));
    expect(await discoverMuseModels(env)).toEqual([
      { id: 'a', label: 'L a', tier: 'default' },
      { id: 'b', label: 'L b' },
    ]);
  });

  it('falls back past a half-written or all-hidden newer file; label defaults to the id', async () => {
    const env = { XDG_DATA_HOME: mkdtempSync(join(tmpdir(), 'muse-cat-')) };
    const dir = museCatalogDir(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'good.json'), JSON.stringify({ rows: [{ model_id: 'x', visibility: 'visible' }] }));
    utimesSync(join(dir, 'good.json'), 1, 1);
    writeFileSync(join(dir, 'hidden.json'), JSON.stringify({ rows: [row('h', 'hidden')] }));
    utimesSync(join(dir, 'hidden.json'), 2, 2);
    writeFileSync(join(dir, 'partial.json'), '{"rows": [');
    expect(await discoverMuseModels(env)).toEqual([{ id: 'x', label: 'x' }]);
  });

  it('throws an actionable error with no cache', async () => {
    const env = { XDG_DATA_HOME: mkdtempSync(join(tmpdir(), 'muse-cat-')) };
    await expect(discoverMuseModels(env)).rejects.toThrow('not cached yet');
  });
});

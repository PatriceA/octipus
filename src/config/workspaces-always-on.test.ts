import { globSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { describe, expect, test } from 'vitest';
import { defaultConfig } from './defaults';
import { multiuserConfigSchema } from './schema';
import { SETTINGS_REGISTRY } from './settings-registry';
import { REMOVED_SETTING_KEYS } from './settings-service';

/**
 * Workspaces are always on. The setting that switched them off is gone from
 * the schema, defaults, registry, both loaders, every reader, the web and the
 * docs; the only place its name may appear is the list of removed settings
 * whose stored rows are deleted at startup.
 *
 * Migrations and the changelog are history and keep the name; the coworking
 * plan describes the removal.
 */
const SEARCH = ['src/**/*.{ts,tsx}', 'scripts/**/*.{ts,mjs,js}', 'web/{app,components,lib}/**/*.{ts,tsx}', 'docs/**/*.md', '*.md'];
const HISTORY = /^(src\/db\/migrations\/|docs\/plans\/|CHANGELOG\.md$)/;
const THIS_FILE = 'src/config/workspaces-always-on.test.ts';
const PATTERN = /orgWorkspaces|ORG_WORKSPACES/;

describe('workspaces are always on', () => {
  test('no orgWorkspaces key anywhere but the removed-settings list', () => {
    const hits: string[] = [];
    for (const file of SEARCH.flatMap((glob) => globSync(glob)).map((f) => f.split(sep).join('/'))) {
      if (file.includes('/node_modules/') || HISTORY.test(file) || file === THIS_FILE) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => { if (PATTERN.test(line)) hits.push(`${file}:${i + 1}:${line.trim()}`); });
    }
    expect(hits).toEqual([
      expect.stringMatching(/^src\/config\/settings-service\.ts:\d+:export const REMOVED_SETTING_KEYS/),
    ]);
  });

  test('the config layers carry no such key', () => {
    expect(SETTINGS_REGISTRY.some((def) => def.key === 'multiuser.orgWorkspaces')).toBe(false);
    expect(Object.keys(defaultConfig.multiuser ?? {})).not.toContain('orgWorkspaces');
    // A stale value (an old env file, a stored row) is dropped, not honoured.
    expect('orgWorkspaces' in multiuserConfigSchema.parse({ orgWorkspaces: false })).toBe(false);
    expect(REMOVED_SETTING_KEYS).toContain('multiuser.orgWorkspaces');
  });
});

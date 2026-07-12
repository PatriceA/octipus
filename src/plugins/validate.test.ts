/**
 * Plugin validation kit tests (WS3) — validatePlugin over the real example
 * plugin and synthetic broken fixtures.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { validatePlugin } from '@octipus/plugin-sdk/testing';

const tmpDirs: string[] = [];
function makePlugin(manifest: unknown, entry: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-plugin-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'index.ts'), entry);
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const goodEntry = `export default {
  name: 'p',
  async initialize() {},
  tools: { greet: async (a) => ({ hi: a.name }) },
  async shutdown() {},
};`;

const goodManifest = {
  name: 'p', version: '1.0.0', description: 'd', apiVersion: '1.0.0', main: 'index.ts',
  capabilities: { tools: [{ name: 'greet', description: 'g', parameters: { name: { type: 'string', description: 'n' } } }] },
};

describe('validatePlugin — happy path', () => {
  test('the repo example plugin validates clean', async () => {
    const report = await validatePlugin(resolve('extensions/example-plugin'));
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.passed).toEqual(expect.arrayContaining([expect.stringContaining('manifest schema valid')]));
  });

  test('a synthetic well-formed plugin validates clean', async () => {
    const report = await validatePlugin(makePlugin(goodManifest, goodEntry));
    expect(report.ok).toBe(true);
    expect(report.passed).toEqual(expect.arrayContaining([expect.stringContaining('tool "greet" dry-run ok')]));
  });
});

describe('validatePlugin — failures', () => {
  test('missing plugin.json → error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octipus-plugin-'));
    tmpDirs.push(dir);
    const report = await validatePlugin(dir);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toContain('no plugin.json');
  });

  test('invalid JSON → error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'octipus-plugin-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'plugin.json'), '{ not json');
    const report = await validatePlugin(dir);
    expect(report.ok).toBe(false);
    expect(report.errors[0]).toContain('not valid JSON');
  });

  test('a declared tool with no matching function → error', async () => {
    const dir = makePlugin(
      { ...goodManifest, capabilities: { tools: [{ name: 'missing', description: 'x', parameters: {} }] } },
      `export default { name: 'p', tools: {} };`,
    );
    const report = await validatePlugin(dir);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('declared tool "missing" has no matching function');
  });

  test('an incompatible apiVersion → error', async () => {
    const dir = makePlugin({ ...goodManifest, apiVersion: '2.0.0' }, goodEntry);
    const report = await validatePlugin(dir);
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('incompatible');
  });

  test('a tool that throws on fixtures → warning (not fatal)', async () => {
    const dir = makePlugin(
      goodManifest,
      `export default { name: 'p', tools: { greet: async () => { throw new Error('boom'); } } };`,
    );
    const report = await validatePlugin(dir);
    expect(report.ok).toBe(true); // warnings don't fail validation
    expect(report.warnings.join(' ')).toContain('threw on fixture input');
  });

  test('a legacy plugin (no apiVersion) → ok with a warning', async () => {
    const { apiVersion, ...legacy } = goodManifest;
    void apiVersion;
    const report = await validatePlugin(makePlugin(legacy, goodEntry));
    expect(report.ok).toBe(true);
    expect(report.warnings.join(' ')).toContain('legacy');
  });
});

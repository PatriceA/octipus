import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayEventBus } from '@/core/gateway/event-bus';
import { discoverExtensions, loadExtension } from './loader';
import { ExtensionRegistry } from './registry';

describe('Extension Discovery + Loader', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let bus: GatewayEventBus;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'octipus-ext-'));
    home = join(root, 'home');
    cwd = join(root, 'project');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    bus = new GatewayEventBus();
  });

  afterEach(() => {
    bus.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  test('returns nothing when no extension dirs exist', () => {
    expect(discoverExtensions({ home, cwd })).toEqual([]);
  });

  test('discovers single-file extension at user home root', () => {
    const dir = join(home, '.octipus', 'extensions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'hello.ts'), 'export default function () {}');

    const found = discoverExtensions({ home, cwd });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('hello');
    expect(found[0].entryPath).toBe(join(dir, 'hello.ts'));
  });

  test('discovers directory-based extension via index.ts', () => {
    const dir = join(cwd, '.octipus', 'extensions', 'my-ext');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.ts'), 'export default function () {}');

    const found = discoverExtensions({ home, cwd });
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe('my-ext');
    expect(found[0].entryPath).toBe(join(dir, 'index.ts'));
  });

  test('skips files starting with . or _', () => {
    const dir = join(home, '.octipus', 'extensions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '_helper.ts'), 'export default function () {}');
    writeFileSync(join(dir, '.hidden.ts'), 'export default function () {}');
    writeFileSync(join(dir, 'real.ts'), 'export default function () {}');

    const found = discoverExtensions({ home, cwd });
    expect(found.map(f => f.name)).toEqual(['real']);
  });

  test('first-seen wins when same name appears in user and project', () => {
    const userDir = join(home, '.octipus', 'extensions');
    const projDir = join(cwd, '.octipus', 'extensions');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(userDir, 'shared.ts'), 'export default function () {}');
    writeFileSync(join(projDir, 'shared.ts'), 'export default function () {}');

    const found = discoverExtensions({ home, cwd });
    // user dir is first in defaultDirs, so it wins
    expect(found).toHaveLength(1);
    expect(found[0].entryPath).toBe(join(userDir, 'shared.ts'));
  });

  test('loadExtension imports the module and runs the factory', async () => {
    const dir = join(cwd, '.octipus', 'extensions');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'pingpong.ts');
    writeFileSync(file, [
      `export default function (api) {`,
      `  api.registerCommand({`,
      `    name: 'pingfromtest',`,
      `    description: 'pong',`,
      `    handler: async () => ({ text: 'pong!' }),`,
      `  });`,
      `}`,
    ].join('\n'));

    const loaded = await loadExtension({ name: 'pingpong', entryPath: file }, bus);
    expect(loaded).toBeDefined();
    expect(loaded?.name).toBe('pingpong');

    const { getCommandRegistry } = await import('@/core/gateway/commands');
    const result = await getCommandRegistry().execute('/pingfromtest', {
      userId: 'u', sessionId: 's', clientType: 'tui', trustLevel: 'user',
    });
    expect(result?.text).toBe('pong!');

    await loaded?.dispose();
  });

  test('loadExtension returns undefined when file has no default export', async () => {
    const dir = join(cwd, '.octipus', 'extensions');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'broken.ts');
    writeFileSync(file, 'export const notDefault = 1;');

    const loaded = await loadExtension({ name: 'broken', entryPath: file }, bus);
    expect(loaded).toBeUndefined();
  });

  test('ExtensionRegistry.reload disposes commands and re-runs discovery to add new files', async () => {
    const dir = join(cwd, '.octipus', 'extensions');
    mkdirSync(dir, { recursive: true });

    writeFileSync(join(dir, 'first.ts'), [
      `export default function (api) {`,
      `  api.registerCommand({`,
      `    name: 'firstcmd',`,
      `    description: 'first',`,
      `    handler: async () => ({ text: 'first' }),`,
      `  });`,
      `}`,
    ].join('\n'));

    const reg = new ExtensionRegistry(bus);
    await reg.loadAll({ home, cwd });

    const { getCommandRegistry } = await import('@/core/gateway/commands');
    expect((await getCommandRegistry().execute('/firstcmd', {
      userId: 'u', sessionId: 's', clientType: 'tui', trustLevel: 'user',
    }))?.text).toBe('first');

    // Add a new extension file on disk and reload — the registry should
    // tear down the old entry list, re-discover, and pick it up.
    writeFileSync(join(dir, 'second.ts'), [
      `export default function (api) {`,
      `  api.registerCommand({`,
      `    name: 'secondcmd',`,
      `    description: 'second',`,
      `    handler: async () => ({ text: 'second' }),`,
      `  });`,
      `}`,
    ].join('\n'));

    const reloadResult = await reg.reload({ home, cwd });
    expect(reloadResult.count).toBe(2);

    expect((await getCommandRegistry().execute('/secondcmd', {
      userId: 'u', sessionId: 's', clientType: 'tui', trustLevel: 'user',
    }))?.text).toBe('second');

    await reg.disposeAll();

    // After dispose, both commands are unregistered.
    expect((await getCommandRegistry().execute('/firstcmd', {
      userId: 'u', sessionId: 's', clientType: 'tui', trustLevel: 'user',
    }))?.text).toContain('Unknown command');
    expect((await getCommandRegistry().execute('/secondcmd', {
      userId: 'u', sessionId: 's', clientType: 'tui', trustLevel: 'user',
    }))?.text).toContain('Unknown command');
  });

  test('one bad extension does not block others', async () => {
    const dir = join(cwd, '.octipus', 'extensions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad.ts'), 'export default function () { throw new Error("init boom"); }');
    writeFileSync(join(dir, 'good.ts'), [
      `export default function (api) {`,
      `  api.registerCommand({`,
      `    name: 'goodone',`,
      `    description: 'ok',`,
      `    handler: async () => ({ text: 'works' }),`,
      `  });`,
      `}`,
    ].join('\n'));

    const reg = new ExtensionRegistry(bus);
    await reg.loadAll({ home, cwd });

    expect(reg.list().map(e => e.name)).toEqual(['good']);
    expect(reg.get('good')).toBeDefined();
    expect(reg.get('bad')).toBeUndefined();

    await reg.disposeAll();
  });
});

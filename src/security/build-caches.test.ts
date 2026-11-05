import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getConfig, resetConfig } from '@/config';
import { personalBuildCaches } from './build-caches';
import { detectRunner } from './shell-sandbox';
import { shellRunOptions } from '@/tools/shell';
import { LocalShellOperations } from '@/tools/shell/local-operations';
import type { AgentContext } from '@/core/types';

vi.mock('node:os', async original => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'octipus-build-home-'));
  vi.mocked(homedir).mockReturnValue(home);
});
afterEach(() => { resetConfig(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

test('reuses existing Gradle downloads and Android identity without exposing their parent', () => {
  mkdirSync(join(home, '.gradle', 'wrapper'), { recursive: true });
  writeFileSync(join(home, '.gradle', 'wrapper', 'existing-distribution'), 'installed');
  const caches = personalBuildCaches();
  expect(caches.paths).toEqual(['.gradle', '.android', '.m2/repository', '.robolectric-download-lock'].map(path => join(home, path)));
  expect(caches.paths).not.toContain(home);
  expect(readFileSync(join(caches.env.GRADLE_USER_HOME, 'wrapper', 'existing-distribution'), 'utf8')).toBe('installed');
});

test.skipIf(process.platform === 'win32')('a build cache symlink cannot expose the entire home', () => {
  symlinkSync(home, join(home, '.gradle'));
  expect(() => personalBuildCaches()).toThrow(/must not resolve to the home/);
});

test.skipIf(detectRunner()?.runner !== 'bwrap')('sandboxed shell jobs persist Gradle lock files and Android state while the rest of home stays hidden', async () => {
  const config = getConfig();
  config.security.shellSandbox = 'required';
  config.workspace.rootPath = join(home, 'workspaces');
  config.workspace.additionalPaths = [];
  writeFileSync(join(home, 'unrelated-secret'), 'must stay hidden');
  mkdirSync(join(home, '.m2'), { recursive: true });
  writeFileSync(join(home, '.m2/settings.xml'), 'private Maven settings');
  const context = { userId: 'aaaaaaaa-0000-4000-8000-00000000a11c', metadata: {}, space: null } as AgentContext;
  const options = shellRunOptions(context, undefined, null);
  const root = options.allowedCwdRoots[0];
  const script = `const fs=require('fs'),a=require('assert/strict');fs.mkdirSync(process.env.GRADLE_USER_HOME+'/wrapper/dists/probe',{recursive:true});fs.writeFileSync(process.env.GRADLE_USER_HOME+'/wrapper/dists/probe/gradle.zip.lck','lock');fs.writeFileSync(process.env.ANDROID_USER_HOME+'/probe','android');fs.writeFileSync(${JSON.stringify(join(home, '.robolectric-download-lock'))},'robolectric');fs.writeFileSync(${JSON.stringify(join(home, '.m2/repository/probe'))},'maven');a.equal(fs.existsSync(${JSON.stringify(join(home, 'unrelated-secret'))}),false);a.equal(fs.existsSync(${JSON.stringify(join(home, '.m2/settings.xml'))}),false);`;
  const command = `node -e '${script.replaceAll("'", "'\\''")}'`;
  const result = await new LocalShellOperations().exec(command, root, options);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(readFileSync(join(home, '.gradle/wrapper/dists/probe/gradle.zip.lck'), 'utf8')).toBe('lock');
  expect(readFileSync(join(home, '.android/probe'), 'utf8')).toBe('android');
  expect(readFileSync(join(home, '.robolectric-download-lock'), 'utf8')).toBe('robolectric');
  expect(readFileSync(join(home, '.m2/repository/probe'), 'utf8')).toBe('maven');
  const second = await new LocalShellOperations().exec(`cat ${JSON.stringify(join(home, '.gradle/wrapper/dists/probe/gradle.zip.lck'))}`, root, options);
  expect(second.exitCode, second.stderr).toBe(0);
  expect(second.stdout).toBe('lock');
});

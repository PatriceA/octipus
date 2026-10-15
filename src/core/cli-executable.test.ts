import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveExecutable } from './cli-executable';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('CLI executable resolution', () => {
  it('resolves an executable in a PATH directory containing spaces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli path ')); dirs.push(dir);
    const executable = join(dir, 'test-cli'); writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o755);
    expect(resolveExecutable('test-cli', dir)).toBe(executable);
    expect(resolveExecutable(executable, '/missing')).toBe(executable);
  });
  it('rejects directories and names the searched PATH in configuration errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-path-')); dirs.push(dir); mkdirSync(join(dir, 'test-cli'));
    expect(() => resolveExecutable('test-cli', dir)).toThrow(`Searched PATH=${dir}`);
  });
});

it('honors the configured absolute CLI path and reports a missing replacement immediately', async () => {
  const { getConfig } = await import('@/config');
  const { configuredCliBinary } = await import('./cli-executable');
  const config = getConfig().cliModels;
  const original = config.claudeCode.binaryPath;
  const dir = mkdtempSync(join(tmpdir(), 'configured cli ')); dirs.push(dir);
  const executable = join(dir, 'custom-claude'); writeFileSync(executable, '#!/bin/sh\nexit 0\n'); chmodSync(executable, 0o755);
  try {
    config.claudeCode.binaryPath = executable;
    expect(configuredCliBinary('claude')).toBe(executable);
    rmSync(executable);
    expect(() => configuredCliBinary('claude')).toThrow('Configure cliModels binaryPath');
  } finally { config.claudeCode.binaryPath = original; }
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { ensureCliBridgeBuilt } from './cli-bridge-build';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

test('does nothing when the bridge is built', () => {
  root = mkdtempSync(join(tmpdir(), 'octipus-bridge-'));
  mkdirSync(join(root, 'mcp-server', 'dist'), { recursive: true });
  writeFileSync(join(root, 'mcp-server', 'dist', 'index.js'), '');
  expect(ensureCliBridgeBuilt(root)).toBe('present');
});

test('says what to run, once, when it cannot build', () => {
  root = mkdtempSync(join(tmpdir(), 'octipus-bridge-'));
  mkdirSync(join(root, 'mcp-server'), { recursive: true });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(ensureCliBridgeBuilt(root)).toBe('missing');
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain('npm run build --prefix mcp-server');
});

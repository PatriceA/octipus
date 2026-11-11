import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { privateWindowsProxyPipe, wrapWindowsPluginCommand } from './windows-plugin-sandbox';
const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), 'windows-contract-')); temps.push(path); return path; }

test('launch record preserves arguments, isolates scratch and carries broker authority', () => {
  const pkg = root(); const data = join(root(), 'data'); mkdirSync(data);
  const pipe = privateWindowsProxyPipe();
  expect(pipe).toMatch(/^\\\\\.\\pipe\\LOCAL\\octipus-[a-f0-9-]+$/);
  const command = wrapWindowsPluginCommand('trusted.exe', ['node', '-e', 'a "quoted" value\\', '--', pipe, 'node'], {
    workspaceRoot: pkg, workspaceReadOnly: true, extraReadWrite: [data], allowNetwork: false,
  }, { pipe, proxyPort: 1234, authority: 'a'.repeat(64) });
  const recordPath = command.argv[2];
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  expect(record).toMatchObject({ version: 1, authority: 'a'.repeat(64), root: pkg, writable: [data], pipe, proxyPort: 1234,
    argv: [process.execPath, '-e', 'a "quoted" value\\', '--', pipe, process.execPath] });
  expect(recordPath.startsWith(`${record.scratch}/`)).toBe(false);
  expect(command.runner).toBe('appcontainer');
  command.cleanup(); command.cleanup();
  expect(existsSync(recordPath)).toBe(false);
  expect(existsSync(record.scratch)).toBe(false);
});

test('refuses broader shell, network, USB and SSH access without starting a child', () => {
  const pkg = root();
  for (const extra of [{ workspaceReadOnly: false }, { allowNetwork: true }, { allowHostUsb: true }, { loopbackPorts: [80] }]) {
    expect(() => wrapWindowsPluginCommand('trusted.exe', ['node'], { workspaceRoot: pkg, workspaceReadOnly: true, ...extra })).toThrow(/plugin packages only/);
  }
  expect(() => wrapWindowsPluginCommand('trusted.exe', ['unsafe.cmd'], { workspaceRoot: pkg, workspaceReadOnly: true })).toThrow(/native .exe runtime/);
});

import { runInNewContext } from 'node:vm';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { privateWindowsProxyPipe, windowsProxyPreload, wrapWindowsPluginCommand } from './windows-plugin-sandbox';
const temps: string[] = [];
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), 'windows-contract-')); temps.push(path); return path; }

test('launch record preserves arguments, isolates scratch and carries broker authority', () => {
  const pkg = root(); const data = join(root(), 'data'); mkdirSync(data);
  const pipe = privateWindowsProxyPipe();
  expect(pipe).toMatch(/^\\\\\.\\pipe\\LOCAL\\octipus-[a-f0-9-]+$/);
  const command = wrapWindowsPluginCommand('trusted.exe', ['node', '-e', 'a "quoted" value\\'], {
    workspaceRoot: pkg, workspaceReadOnly: true, extraReadWrite: [data], allowNetwork: false,
  }, { pipe, proxyPort: 1234, authority: 'a'.repeat(64) });
  const recordPath = command.argv[2];
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  expect(record).toMatchObject({ version: 1, authority: 'a'.repeat(64), root: pkg, writable: [data], pipe, proxyPort: 1234,
    argv: [process.execPath, '-e', 'a "quoted" value\\'] });
  expect(readFileSync(record.preload, 'utf8')).toContain('net.Socket.prototype.connect');
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


test('proxy adapter handles Node connect overloads and leaves direct sockets to OS enforcement', () => {
  const calls: unknown[][] = [];
  class Socket { connect(...args: unknown[]) { calls.push(args); return this; } }
  const net = { Socket };
  const pipe = privateWindowsProxyPipe();
  runInNewContext(windowsProxyPreload(pipe, 1234), { require: (name: string) => { expect(name).toBe('node:net'); return net; } });
  const socket = new Socket(); const callback = () => {};
  socket.connect({ host: '127.0.0.1', port: 1234 }, callback);
  socket.connect([{ host: 'localhost', port: '1234' }, callback]);
  socket.connect(1234, '127.0.0.1', callback);
  for (const call of calls) { expect(call[0]).toEqual({ path: pipe }); expect(call[1]).toBe(callback); }
  calls.length = 0;
  socket.connect({ host: 'example.com', port: 1234 });
  socket.connect({ host: '127.0.0.1', port: 4321 });
  socket.connect({ path: 'another-pipe' });
  expect(calls).toEqual([[{ host: 'example.com', port: 1234 }], [{ host: '127.0.0.1', port: 4321 }], [{ path: 'another-pipe' }]]);
});

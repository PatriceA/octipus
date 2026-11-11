/** Native Windows plugin launcher. This never falls back to a host shell. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WrapOptions, WrapResult } from './shell-sandbox';

export const WINDOWS_SANDBOX_PROTOCOL = 1;

/** Only application-owned locations; never look up this security boundary on PATH. */
export function windowsSandboxBinary(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source execution (src/security) and the production bundle (dist).
  for (const root of [resolve(here, '../..'), resolve(here, '..')]) {
    const candidate = join(root, 'native', 'bin', 'octipus-sandbox.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function executable(command: string, root: string, path: string | undefined): string {
  if (command === 'node' || command === 'node.exe') return process.execPath;
  const candidates = isAbsolute(command) || /[/\\]/.test(command)
    ? [resolve(root, command)]
    : (path ?? process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, command));
  for (const candidate of candidates) {
    for (const file of /\.exe$/i.test(candidate) ? [candidate] : [candidate, `${candidate}.exe`]) {
      if (/\.exe$/i.test(file) && existsSync(file)) return file;
    }
  }
  throw new Error(`Windows plugin sandbox needs a native .exe runtime: ${command}. Use node for JavaScript packages; .cmd/.bat shell shims are not executed.`);
}

export interface WindowsLaunchOptions {
  pipe?: string;
  proxyPort?: number;
  authority?: string;
}

/** JSON avoids command-line interpolation and preserves arguments containing spaces/quotes. */
export function wrapWindowsPluginCommand(binary: string, argv: string[], options: WrapOptions, broker: WindowsLaunchOptions = {}): WrapResult {
  if (!options.workspaceReadOnly || options.allowNetwork || options.allowHostUsb || options.sshAgent || options.loopbackPorts?.length) {
    throw new Error('The Windows AppContainer runner supports isolated plugin packages only: read-only package, private writable data, and network through its broker. Host shell/USB/SSH grants are not supported.');
  }
  if (!argv.length) throw new Error('Windows plugin sandbox requires a command');
  const scratch = mkdtempSync(join(tmpdir(), 'octipus-plugin-'));
  // The launch record is outside the granted scratch: the child cannot alter it.
  const record = `${scratch}.json`;
  const cleanup = () => { rmSync(record, { force: true }); rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };
  try {
    const command = [executable(argv[0], options.workspaceRoot, options.path), ...argv.slice(1)];
    const preload = broker.pipe ? join(scratch, 'egress.cjs') : null;
    if (preload) writeFileSync(preload, windowsProxyPreload(broker.pipe!, broker.proxyPort!));
    writeFileSync(record, JSON.stringify({
      version: WINDOWS_SANDBOX_PROTOCOL,
      authority: broker.authority ?? createHash('sha256').update('offline').digest('hex'),
      argv: command,
      preload,
      root: options.workspaceRoot,
      readOnly: options.extraReadOnly ?? [],
      writable: options.extraReadWrite ?? [],
      scratch,
      ...(broker.pipe ? { pipe: broker.pipe, proxyPort: broker.proxyPort } : {}),
    }), { mode: 0o600 });
    return { wrapped: true, runner: 'appcontainer', argv: [binary, '--config', record], cleanup };
  } catch (error) { cleanup(); throw error; }
}

export function privateWindowsProxyPipe(): string {
  return `\\\\.\\pipe\\LOCAL\\octipus-${randomUUID()}`;
}


/** A compatibility adapter, not a security check: the OS still denies every
 * direct socket. Only a proxy-aware Node client's connection to its configured
 * proxy is replaced with the private broker pipe. No TCP listener/exemption. */
export function windowsProxyPreload(pipe: string, port: number): string {
  return `
const net = require('node:net');
const original = net.Socket.prototype.connect;
const pipe = ${JSON.stringify(pipe)}, port = ${JSON.stringify(port)};
net.Socket.prototype.connect = function(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const opts = typeof first === 'object' && first !== null ? first : { port:first, host:typeof normalized[1]==='string'?normalized[1]:'localhost' };
  const host = opts.host || opts.hostname || 'localhost';
  if (!opts.path && Number(opts.port) === port && ['127.0.0.1','localhost','::1'].includes(host)) {
    const callback = normalized.find(value=>typeof value==='function');
    return original.call(this, { path:pipe }, callback);
  }
  return original.apply(this,args);
};
`;
}

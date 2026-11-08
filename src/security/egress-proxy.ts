/**
 * Egress proxy — per-host network for sandboxed stdio servers (plugin
 * packages, docs/PLUGIN-PACKAGES.md#network).
 *
 * A manifest's `network: [hosts]` used to be a boolean: any host turned the
 * whole network on. This module narrows it to the declared hosts. One proxy
 * runs per server process, in this process, on 127.0.0.1 (an ephemeral port)
 * and, off Windows, on a Unix socket. It speaks HTTP CONNECT (for HTTPS and
 * any other TCP) and plain-HTTP forwarding, lets through only a declared
 * host — on 443 or 80, or on exactly the port an entry names
 * (`api.example.com:8443`) — and answers everything else 403, logging the
 * refusal with the package and the host.
 *
 * Where it is enforced and where it is only advice:
 *
 * - **Linux with bwrap or firejail** (`security.shellSandbox` `auto` or
 *   `required`): the server runs in its own network namespace with only
 *   loopback. The Unix socket is mounted in, and a small launcher
 *   (`SANDBOX_BRIDGE_SOURCE`, run with this Node binary inside the sandbox)
 *   listens on the namespace's 127.0.0.1 and forwards to it before starting
 *   the server with the proxy variables. Nothing else leaves the namespace,
 *   so the proxy is the only way out: enforced.
 * - **Sandbox off (the default), no runner found, macOS, Windows**: the
 *   server runs unwrapped with HTTP(S)_PROXY / ALL_PROXY pointing at the TCP
 *   listener. Well-behaved HTTP clients honour it, but nothing stops a direct
 *   connection: advisory only. The package's status says so.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, request as httpRequest, type ServerResponse } from 'node:http';
import { connect as netConnect, createServer as createNetServer, isIP, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreLogger } from '@/utils/logger';

/** Ports a host entry without a port allows. */
const DEFAULT_PORTS = [443, 80];

interface AllowEntry { host: string; wildcard: boolean; ports: number[] }

function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** Parse `host`, `*.host`, `host:port` or `*.host:port`. */
export function parseAllowEntry(entry: string): AllowEntry {
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(entry.trim()) as RegExpExecArray;
  let host = normalizeHost(m[1]);
  const wildcard = host.startsWith('*.');
  if (wildcard) host = host.slice(2);
  const port = m[2] ? Number(m[2]) : null;
  return { host, wildcard, ports: port !== null && port > 0 && port < 65536 ? [port] : DEFAULT_PORTS };
}

/**
 * Whether `host:port` is allowed by the declared entries: an exact host
 * match, or for `*.example.com` any subdomain of example.com (not the apex
 * itself — declare it too).
 */
export function hostAllowed(allowed: readonly string[], host: string, port: number): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return allowed.some((raw) => {
    const e = parseAllowEntry(raw);
    if (!e.ports.includes(port)) return false;
    return e.wildcard ? h.endsWith(`.${e.host}`) && isIP(h) === 0 : h === e.host;
  });
}

/** Split a CONNECT authority (`host:port`, `[v6]:port`). */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority.trim());
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: normalizeHost(m[1]), port };
}

/** The proxy variables a child gets, NO_PROXY cleared so nothing bypasses it. */
export function proxyEnv(url: string): Record<string, string> {
  return {
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url,
    http_proxy: url, https_proxy: url, all_proxy: url,
    NO_PROXY: '', no_proxy: '',
  };
}

export interface EgressProxyOptions {
  /** Who the traffic belongs to, for the refusal log (a package name). */
  label: string;
  /** Declared host entries (see `parseAllowEntry`). */
  allowed: readonly string[];
  /** Also listen on a Unix socket, for a sandbox without network (not on Windows). */
  unixSocket?: boolean;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  port: number;
  /** The Unix socket, when asked for. */
  socketPath: string | null;
  /** The directory holding the socket, to mount into a sandbox. */
  socketDir: string | null;
  close(): Promise<void>;
}

/** Start a proxy that lets through only `allowed`. */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const { label, allowed } = options;
  const open = new Set<Socket>();
  const track = (s: Socket) => { open.add(s); s.once('close', () => open.delete(s)); };

  const refuse = (host: string, port: number, kind: string) => {
    coreLogger.warn({ pkg: label, host, port, kind }, 'Plugin package network request refused: host not declared in its manifest');
  };

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Proxy requests must use an absolute http:// URL\n');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('Only http:// is forwarded; use CONNECT for https\n');
      return;
    }
    const host = normalizeHost(target.hostname);
    const port = target.port ? Number(target.port) : 80;
    if (!hostAllowed(allowed, host, port)) {
      refuse(host, port, 'http');
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`Host ${host}:${port} is not declared in this package's network list\n`);
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest({ host, port, method: req.method, path: `${target.pathname}${target.search}`, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`Upstream error: ${err.message}\n`);
      else res.destroy();
    });
    req.pipe(upstream);
  });

  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    const authority = parseAuthority(req.url ?? '');
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (!hostAllowed(allowed, authority.host, authority.port)) {
      refuse(authority.host, authority.port, 'connect');
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nHost not declared in this package\'s network list\n');
      return;
    }
    const upstream = netConnect(authority.port, authority.host);
    track(upstream);
    let established = false;
    upstream.once('connect', () => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!established && client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    });
    client.on('close', () => upstream.destroy());
  });
  server.on('connection', track);
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  let unix: NetServer | null = null;
  let socketDir: string | null = null;
  let socketPath: string | null = null;
  if (options.unixSocket && process.platform !== 'win32') {
    // sun_path is ~108 bytes; fall back to /tmp when TMPDIR is long.
    const base = join(tmpdir(), 'octipus-egress-XXXXXX/proxy.sock').length < 100 ? tmpdir() : '/tmp';
    socketDir = mkdtempSync(join(base, 'octipus-egress-'));
    socketPath = join(socketDir, 'proxy.sock');
    unix = createNetServer((socket) => server.emit('connection', socket));
    await new Promise<void>((resolve, reject) => {
      unix!.once('error', reject);
      unix!.listen(socketPath, () => { unix!.off('error', reject); resolve(); });
    });
  }

  let closed: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    socketPath,
    socketDir,
    close() {
      closed ??= (async () => {
        for (const s of open) s.destroy();
        await Promise.all([
          new Promise<void>((r) => server.close(() => r())),
          unix ? new Promise<void>((r) => unix!.close(() => r())) : Promise.resolve(),
        ]);
        if (socketDir) rmSync(socketDir, { recursive: true, force: true });
      })();
      return closed;
    },
  };
}

/**
 * The launcher run inside a sandbox without network:
 * `node -e SANDBOX_BRIDGE_SOURCE -- <socket> <command> [args...]`.
 * It listens on the namespace's own 127.0.0.1, forwards each connection to
 * the proxy's Unix socket, and runs the command with the proxy variables
 * pointing at it, passing stdio through and exiting with its code.
 */
export const SANDBOX_BRIDGE_SOURCE = `
const net = require('node:net');
const { spawn } = require('node:child_process');
const [sock, ...cmd] = process.argv.slice(1);
const srv = net.createServer((c) => {
  const u = net.connect(sock);
  c.pipe(u); u.pipe(c);
  c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
  c.on('close', () => u.destroy()); u.on('close', () => c.destroy());
});
srv.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + srv.address().port;
  const env = { ...process.env, NO_PROXY: '', no_proxy: '' };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[k] = url;
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env });
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s));
  child.on('error', (e) => { process.stderr.write(String(e && e.message || e) + '\\n'); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
});
`;

/** `argv` run through the sandbox launcher, reaching the proxy at `socketPath`. */
export function bridgedArgv(argv: string[], socketPath: string): string[] {
  return [process.execPath, '-e', SANDBOX_BRIDGE_SOURCE, '--', socketPath, ...argv];
}

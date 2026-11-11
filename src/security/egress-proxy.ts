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
 * A declared host is resolved once, here; if any address is loopback,
 * private, link-local, CGNAT, unique-local, unspecified, IPv4-mapped private
 * or a metadata address (`isPrivateIP`), the request is refused 403. The
 * connection goes to the checked address, so a second resolution cannot
 * rebind it. A CONNECT tunnel cannot see the TLS server name (SNI), so a
 * client can front another name served from the same address: a known limit.
 *
 * Where it is enforced and where it is only advice:
 *
 * - **Linux with bwrap or firejail** (a plugin package: `plugins.sandbox`
 *   `required`, the default, or any marketplace package; another stdio
 *   server: `security.shellSandbox` `auto` or `required`): the server runs in its own network namespace with only
 *   loopback. The Unix socket is mounted in, and a small launcher
 *   (`SANDBOX_BRIDGE_SOURCE`, run with this Node binary inside the sandbox)
 *   listens on the namespace's 127.0.0.1 and forwards to it before starting
 *   the server with the proxy variables. Nothing else leaves the namespace,
 *   so the proxy is the only way out: enforced.
 * - **macOS with sandbox-exec** (same setting): no network namespace exists,
 *   so there is nothing to bridge into — a bridge's 127.0.0.1 would be the
 *   host's. No Unix socket is opened; the Seatbelt profile
 *   (`buildSeatbeltProfile` in shell-sandbox.ts) denies all network but
 *   outbound TCP to this proxy's loopback port, and the server gets the proxy
 *   variables pointing at that port directly: enforced.
 * - **Windows with AppContainer**: no network capabilities or loopback
 *   exemption. The native helper brokers a private SID-protected named pipe
 *   to this TCP listener; a Node preload routes proxy-aware clients straight
 *   to that pipe without a local TCP listener. Direct host loopback and internet remain inaccessible.
 * - **Sandbox off** (a local plugin package under `plugins.sandbox: off`):
 *   the server runs unwrapped with HTTP(S)_PROXY /
 *   ALL_PROXY pointing at the TCP listener. Well-behaved HTTP clients honour
 *   it, but nothing stops a direct connection: advisory only. The package's
 *   status and its declarations say so ("Network not enforced on this host").
 *   Where a sandbox is required and no runner works, the server is not
 *   started at all (src/plugins/packages/sandbox-policy.ts).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, request as httpRequest, type ServerResponse } from 'node:http';
import { connect as netConnect, createServer as createNetServer, isIP, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLUGIN_HOST_ALIAS } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { assertPublicAddress, pinnedLookup } from '@/utils/sanitize';

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

/** Resolve a host name to its addresses (all of them, both families). */
export type EgressResolver = (host: string) => Promise<string[]>;

const systemResolver: EgressResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Headers that belong to one hop (RFC 9110 §7.6.1) and never cross the
 * proxy, in either direction. `transfer-encoding` goes too: Node frames the
 * forwarded body itself (content-length when it is known, chunked when not).
 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/** `headers` without the hop-by-hop ones, `Proxy-*` and whatever `Connection` lists. */
export function stripHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const listed = new Set(String(headers.connection ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const n = name.toLowerCase();
    if (HOP_BY_HOP.has(n) || listed.has(n) || n.startsWith('proxy-')) continue;
    out[n] = value;
  }
  return out;
}

export interface EgressProxyOptions {
  /** Who the traffic belongs to, for the refusal log (a package name). */
  label: string;
  /** Declared host entries (see `parseAllowEntry`). */
  allowed: readonly string[];
  /** Also listen on a Unix socket, for a sandbox without network (not on Windows). */
  unixSocket?: boolean;
  /**
   * Where to create the socket's directory (see `socketDirFor`). Not /tmp:
   * firejail runs with `--private-tmp`, which hides the host's /tmp from the
   * sandbox whatever is whitelisted under it, and bwrap mounts a per-spawn
   * scratch over /tmp. The transport passes a directory under the Octipus
   * workspace, which both runners mount by path like the package directory.
   */
  socketParent?: string;
  /** How declared hosts are resolved. Tests inject one; the default is the system resolver. */
  resolve?: EgressResolver;
  /**
   * Test-only: let a declared host resolve to a loopback/private address, so
   * tests can run against servers on 127.0.0.1. Never set from a manifest or
   * by the transport — production always refuses private addresses.
   */
  allowPrivateAddresses?: boolean;
  /**
   * The host's own API, for a package that declares `host` scopes
   * (docs/PLUGIN-PACKAGES.md#host-api): plain-HTTP requests to
   * `http://octipus-host.internal/api/plugin-host/…` (`PLUGIN_HOST_ALIAS`, port
   * 80) are forwarded to exactly this address and port. The name is never
   * resolved; any other path, port or method of reaching it (CONNECT) is
   * refused, and without this option the name is refused like any
   * undeclared host.
   */
  hostApi?: { host: string; port: number };
}

/** The only path prefix forwarded to the host API. */
export const HOST_API_PATH_PREFIX = '/api/plugin-host/';
/** The header the proxy stamps on host API requests with the package's label (any client copy is dropped). */
export const HOST_API_EGRESS_HEADER = 'x-octipus-plugin-egress';
/** The header carrying the proxy's own secret, which proves the request came through it. */
export const HOST_API_EGRESS_KEY_HEADER = 'x-octipus-plugin-egress-key';

/**
 * The secret of every live proxy with a host API target, by package label.
 * Generated at proxy start, kept only here, dropped at close: the host API
 * accepts a request only with the secret of a live proxy of the package the
 * stamp names (`egressStampValid`), so the stamp cannot be forged by a
 * client reaching the API directly. A label can briefly have two proxies (a
 * restart), hence a set.
 */
const egressKeys = new Map<string, Set<string>>();

/** Whether `key` is the secret of a live proxy of `label`. Constant time per candidate. */
export function egressStampValid(label: string, key: string | null | undefined): boolean {
  if (!key) return false;
  const given = Buffer.from(key);
  for (const candidate of egressKeys.get(label) ?? []) {
    const known = Buffer.from(candidate);
    if (known.length === given.length && timingSafeEqual(known, given)) return true;
  }
  return false;
}

/**
 * Whether `pathname` may be forwarded to the host API: under
 * `/api/plugin-host/`, with nothing that a server could decode into another
 * path (`%`, a backslash, an empty or dot segment).
 */
export function hostApiPathAllowed(pathname: string): boolean {
  if (!pathname.startsWith(HOST_API_PATH_PREFIX) || /[%\\]/.test(pathname)) return false;
  return pathname.slice(1).split('/').every((s, i, all) => (s !== '' || i === all.length - 1) && s !== '.' && s !== '..');
}

/** The headers a host API request carries on: no cookie, no forwarding or Octipus headers of the client's, the proxy's label. */
function hostApiHeaders(headers: IncomingHttpHeaders, label: string, key: string, target: { host: string; port: number }): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(stripHopByHop(headers))) {
    if (name === 'cookie' || name === 'host' || name.startsWith('x-forwarded') || name === 'forwarded' || name.startsWith('x-octipus') || name === 'x-real-ip') continue;
    out[name] = value;
  }
  out.host = `${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}`;
  out[HOST_API_EGRESS_HEADER] = label;
  out[HOST_API_EGRESS_KEY_HEADER] = key;
  return out;
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

/** Longest socket path created: sun_path is 108 bytes on Linux, 104 on macOS. */
const MAX_SOCKET_PATH = 100;

/**
 * A fresh private directory for the proxy socket: under `parent` when the
 * path fits in sun_path, else under `$XDG_RUNTIME_DIR` (`/run/user/<uid>`,
 * which bwrap mounts by path and firejail can whitelist), and only as a last
 * resort under the temp directory — where firejail's `--private-tmp` may
 * hide it, which the warning says.
 */
function socketDirFor(parent: string | undefined, label: string): string {
  const fits = (base: string) => join(base, 'egress-XXXXXX', 'proxy.sock').length < MAX_SOCKET_PATH;
  for (const base of [parent, process.env.XDG_RUNTIME_DIR].filter((b): b is string => !!b)) {
    if (!fits(base)) continue;
    try {
      mkdirSync(base, { recursive: true, mode: 0o700 });
      return mkdtempSync(join(base, 'egress-'));
    } catch { /* try the next */ }
  }
  const tmp = fits(tmpdir()) ? tmpdir() : '/tmp';
  // Worth a warning only when a parent was asked for and could not be used.
  if (parent !== undefined) {
    coreLogger.warn({ pkg: label, dir: tmp }, 'Egress proxy socket falls back to the temp directory; firejail\'s --private-tmp may hide it from the sandbox');
  }
  return mkdtempSync(join(tmp, 'octipus-egress-'));
}

/** Start a proxy that lets through only `allowed`. */
export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const { label, allowed } = options;
  const resolveHost = options.resolve ?? systemResolver;
  /** Every live socket and upstream request, so close() can abort them. */
  const open = new Set<{ destroy(): unknown }>();
  const track = <T extends { destroy(): unknown; once(event: 'close', fn: () => void): unknown }>(s: T): T => {
    open.add(s);
    s.once('close', () => open.delete(s));
    return s;
  };

  const refuse = (host: string, port: number, kind: string) => {
    coreLogger.warn({ pkg: label, host, port, kind }, 'Plugin package network request refused: host not declared in its manifest');
  };

  /**
   * Resolve a declared host once and check every address. Returns the
   * address to connect to — the connection uses it, never the name, so a
   * second resolution (DNS rebinding) cannot swap in another — or why not.
   */
  const vet = async (host: string, port: number, kind: string): Promise<{ ip: string } | { status: 403 | 502; message: string }> => {
    let addresses: string[];
    try {
      addresses = await resolveHost(host);
    } catch (err) {
      return { status: 502, message: `Could not resolve ${host}: ${(err as Error).message}` };
    }
    if (addresses.length === 0) return { status: 502, message: `Could not resolve ${host}` };
    if (!options.allowPrivateAddresses) {
      for (const address of addresses) {
        if (!assertPublicAddress(address).ok) {
          coreLogger.warn({ pkg: label, host, port, address, kind }, 'Plugin package network request refused: declared host resolves to a private address');
          return { status: 403, message: `Host ${host} resolves to a private or reserved address (${address}); refused` };
        }
      }
    }
    return { ip: addresses[0] };
  };

  // This proxy's own secret for the host API stamp; registered while it lives.
  const egressKey = randomBytes(32).toString('base64url');
  if (options.hostApi) {
    const keys = egressKeys.get(label) ?? new Set<string>();
    keys.add(egressKey);
    egressKeys.set(label, keys);
  }
  const forgetKey = () => {
    const keys = egressKeys.get(label);
    keys?.delete(egressKey);
    if (keys && keys.size === 0) egressKeys.delete(label);
  };

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
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
    if (host === PLUGIN_HOST_ALIAS) {
      // The host API: a fixed internal target, never resolved, never another port or path.
      const api = options.hostApi;
      if (!api || port !== 80 || !hostApiPathAllowed(target.pathname)) {
        coreLogger.warn({ pkg: label, host, port, path: target.pathname }, 'Plugin package host API request refused');
        res.writeHead(403, { 'content-type': 'text/plain' }).end(api ? `Only ${HOST_API_PATH_PREFIX}… on port 80 reaches the host API\n` : 'This package declares no host API scopes\n');
        return;
      }
      const upstream = track(httpRequest({
        host: api.host, port: api.port, method: req.method, path: `${target.pathname}${target.search}`,
        headers: hostApiHeaders(req.headers, label, egressKey, api), agent: false,
      }, (up) => {
        res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
        up.pipe(res);
      }));
      upstream.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`Host API error: ${err.message}\n`);
        else res.destroy();
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (!hostAllowed(allowed, host, port)) {
      refuse(host, port, 'http');
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`Host ${host}:${port} is not declared in this package's network list\n`);
      return;
    }
    const vetted = await vet(host, port, 'http');
    if (res.destroyed) return;
    if (!('ip' in vetted)) {
      res.writeHead(vetted.status, { 'content-type': 'text/plain' }).end(`${vetted.message}\n`);
      return;
    }
    // The Host the server sees is the target's, never what the client sent
    // (which could name another virtual host on the same address).
    const headers = { ...stripHopByHop(req.headers), host: target.host };
    const upstream = track(httpRequest({
      host, port, method: req.method, path: `${target.pathname}${target.search}`, headers,
      // Connect to the vetted address; no pooling, so every socket is this request's.
      lookup: pinnedLookup(vetted.ip), agent: false,
    }, (up) => {
      res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
      up.pipe(res);
    }));
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`Upstream error: ${err.message}\n`);
      else res.destroy();
    });
    // The client went away (or the response is done): nothing more to fetch.
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('connect', async (req: IncomingMessage, client: Socket, head: Buffer) => {
    track(client);
    client.on('error', () => client.destroy());
    const authority = parseAuthority(req.url ?? '');
    if (!authority) {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    // The host API is plain HTTP through the proxy only: no tunnel to it, whatever is declared.
    if (authority.host === PLUGIN_HOST_ALIAS || !hostAllowed(allowed, authority.host, authority.port)) {
      refuse(authority.host, authority.port, 'connect');
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nHost not declared in this package\'s network list\n');
      return;
    }
    // Hold bytes a client sends before the tunnel is up (resolution is
    // async); `pipe` resumes it, and a refusal resumes it to see the close.
    client.pause();
    const vetted = await vet(authority.host, authority.port, 'connect');
    if (client.destroyed) return;
    if (!('ip' in vetted)) {
      client.resume();
      const reason = vetted.status === 403 ? 'Forbidden' : 'Bad Gateway';
      client.end(`HTTP/1.1 ${vetted.status} ${reason}\r\nContent-Type: text/plain\r\n\r\n${vetted.message}\n`);
      return;
    }
    // The checked address, not the name: nothing is resolved again. The
    // tunnel cannot see which name the TLS client then asks for (SNI); see
    // docs/PLUGIN-PACKAGES.md#network.
    const upstream = track(netConnect({ host: vetted.ip, port: authority.port }));
    let established = false;
    upstream.once('connect', () => {
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => {
      if (!established && client.writable) client.resume().end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      else client.destroy();
    });
    client.on('close', () => upstream.destroy());
  });
  server.on('connection', track);
  server.on('clientError', (_err, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const failed = (err: Error) => { forgetKey(); reject(err); };
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => { server.off('error', failed); resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  let unix: NetServer | null = null;
  let socketDir: string | null = null;
  let socketPath: string | null = null;
  if (options.unixSocket && process.platform !== 'win32') {
    socketDir = socketDirFor(options.socketParent, label);
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
        forgetKey();
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

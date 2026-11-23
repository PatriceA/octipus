/**
 * The egress policy for shell commands, enforced at the sandbox boundary
 * (docs/EGRESS-POLICY.md#shell-commands).
 *
 * Commands are never parsed for hosts: a command that asked for network gets
 * no network of its own, only an egress proxy (src/security/egress-proxy.ts)
 * that asks the policy about every connection it is asked to make.
 *
 * - **bwrap / firejail (Linux):** the command runs in a network namespace
 *   with nothing but loopback. The proxy's Unix socket is mounted in and the
 *   launcher bridge (`bridgedArgv`) forwards the namespace's 127.0.0.1 to it,
 *   so the proxy is the only way out: enforced.
 * - **sandbox-exec (macOS, `security.shellSandbox: required`):** the
 *   Seatbelt profile allows outbound TCP to the proxy's loopback port and
 *   nothing else: enforced.
 * - **No sandbox** (`off`, `auto` without a working runner, macOS under
 *   `auto`, Windows): the command has the host's network whatever it asked
 *   for. It gets the proxy variables, which well-behaved HTTP clients honour,
 *   but a direct connection is not stopped: advisory only, and the status
 *   (`shellEgressStatus`) says so. With `requireEnforcement` the command is
 *   refused instead.
 * - A sandboxed command that did not ask for network has none at all: nothing
 *   to proxy.
 *
 * Only tool calls are judged (a subject is set); with no active policy
 * nothing changes.
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import { ownNodeBinary } from '@/mcp/transports/stdio';
import { coreLogger } from '@/utils/logger';
import { bridgedArgv, type EgressProxy, proxyEnv, startEgressProxy } from './egress-proxy';
import { activeEgressPolicy, currentEgressSubject, egressDecider, egressPolicyActive, type EgressSubject } from './egress-policy';
import { UNJUDGED_CLI_NATIVE_TOOLS, UNJUDGED_EGRESS } from './egress-coverage';
import { activeSandboxRunner, getSandboxMode, type SandboxMode, type SandboxRunner, type WrapOptions } from './shell-sandbox';

/** How a shell command's network relates to the egress policy. */
export type ShellEgressEnforcement = 'enforced' | 'advisory';

export interface ShellEgress {
  /** The argv to hand to `wrapCommand` (bridged through the launcher on Linux). */
  argv: string[];
  /** Laid over the command's `WrapOptions`. */
  wrap: Pick<WrapOptions, 'allowNetwork' | 'loopbackPorts'> & { extraReadWrite: string[]; extraReadOnly: string[] };
  /** Added to the command's environment. */
  env: Record<string, string>;
  enforcement: ShellEgressEnforcement;
  proxy: EgressProxy;
  close(): void;
}

/** Where the per-command proxy sockets go: a private directory outside any workspace mount. */
export function shellSocketParent(): string | undefined {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? join(runtime, 'octipus-shell-egress') : undefined;
}

let advisoryWarned = false;

let staleCleaned = false;

/**
 * Once per process: remove socket directories a crashed run left behind
 * (`close` never ran). A directory is named `egress-<pid>-...` after the
 * process that made it; it is removed only when that process is gone, so
 * another live Octipus process of the same user keeps its sockets. A
 * directory without a pid (an older version) is removed when it is older
 * than this process.
 */
export function cleanStaleShellSockets(parent = shellSocketParent(), startedAt = Date.now() - process.uptime() * 1000, alive: (pid: number) => boolean = processAlive): void {
  if (!parent) return;
  let entries: string[];
  try { entries = readdirSync(parent); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') coreLogger.warn({ parent, err: (err as Error).message }, 'Shell egress: the proxy socket directory could not be listed');
    return;
  }
  for (const name of entries) {
    if (!name.startsWith('egress-')) continue;
    const path = join(parent, name);
    const pid = /^egress-(\d+)-/.exec(name)?.[1];
    try {
      const stale = pid !== undefined ? Number(pid) !== process.pid && !alive(Number(pid)) : statSync(path).mtimeMs < startedAt;
      if (stale) rmSync(path, { recursive: true, force: true });
    } catch (err) {
      coreLogger.warn({ path, err: (err as Error).message }, 'Shell egress: a stale proxy socket directory could not be removed');
    }
  }
}

/** Whether a process with this pid exists (EPERM: it does, as another user's). */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Inside a network namespace, loopback is the sandbox's own: never proxied. */
export const SANDBOX_LOOPBACK = 'localhost,127.0.0.1,::1';

export interface ShellEgressOptions {
  /** Did the command ask for network (`network: true`, or a host-services stage)? */
  allowNetwork: boolean;
  /** The run's sandbox mode (an environment's), else `security.shellSandbox`. */
  mode?: SandboxMode;
  subject?: EgressSubject;
  /** Test-only: proxy options a test injects (a resolver, private addresses). */
  proxyOverrides?: { resolve?: (host: string) => Promise<string[]>; allowPrivateAddresses?: boolean };
}

/**
 * Prepare one shell command's network under the egress policy, or null when
 * the policy has nothing to do with it (no policy, not a tool call, or a
 * sandboxed command without network). Throws `ToolNotExecutedError` when
 * `requireEnforcement` is set and the sandbox cannot confine the command.
 */
export async function prepareShellEgress(argv: string[], options: ShellEgressOptions): Promise<ShellEgress | null> {
  const subject = options.subject ?? currentEgressSubject();
  if (!subject) return null;
  const policy = activeEgressPolicy();
  if (!egressPolicyActive(policy)) return null;
  const mode = options.mode ?? getSandboxMode();
  const runner = activeSandboxRunner({ mode });
  if (runner && !options.allowNetwork) return null;
  if (!runner && policy.requireEnforcement) {
    throw new ToolNotExecutedError('shell', `The egress policy requires enforced network confinement (security.egressPolicy.requireEnforcement), but shell commands run without a process sandbox here (security.shellSandbox=${mode}${mode === 'off' ? '' : ', no working runner'}), so their network cannot be confined. The command was not run.`);
  }
  const confined = runner === 'bwrap' || runner === 'firejail';
  if (confined && !staleCleaned) { staleCleaned = true; cleanStaleShellSockets(); }
  if (runner === 'firejail' && !shellSocketParent()) {
    coreLogger.warn('Shell egress under firejail without XDG_RUNTIME_DIR: the proxy socket falls back to the temp directory, which firejail hides, so the command will have no network');
  }
  const proxy = await startEgressProxy({
    label: `shell:${subject.tool ?? 'shell'}`, allowed: [], anyHost: true,
    decide: egressDecider({ ...subject, tool: subject.tool ?? 'shell' }, 'shell-proxy'),
    // The socket directory is NOT under the workspace root: another sandboxed
    // command, which mounts workspace folders, must not reach this command's
    // proxy (and its subject). Default: $XDG_RUNTIME_DIR or the temp
    // directory, which bwrap and firejail both hide from every sandbox but
    // the one that mounts this directory by path.
    unixSocket: confined, socketParent: shellSocketParent(),
    ...options.proxyOverrides,
  });
  const close = () => { void proxy.close(); };
  if (confined && proxy.socketPath && proxy.socketDir) {
    return {
      // The namespace's loopback is the command's own (a server it started
      // itself): not through the proxy, which would refuse it as private.
      argv: bridgedArgv(argv, proxy.socketPath), env: { OCTIPUS_BRIDGE_NO_PROXY: SANDBOX_LOOPBACK, OCTIPUS_BRIDGE_TOKEN: proxy.socketToken ?? '' }, enforcement: 'enforced', proxy, close,
      wrap: { allowNetwork: false, extraReadWrite: [proxy.socketDir], extraReadOnly: ownNodeBinary() },
    };
  }
  if (runner === 'sandbox-exec') {
    return {
      argv, env: proxyEnv(proxy.url), enforcement: 'enforced', proxy, close,
      wrap: { allowNetwork: false, loopbackPorts: [proxy.port], extraReadWrite: [], extraReadOnly: [] },
    };
  }
  if (!advisoryWarned) {
    advisoryWarned = true;
    coreLogger.warn({ mode, runner }, 'Egress policy NOT enforced for shell commands: no process sandbox confines them, so the egress proxy is advice only (set security.shellSandbox to auto/required with bwrap or firejail installed)');
  }
  return {
    argv, env: proxyEnv(proxy.url), enforcement: 'advisory', proxy, close,
    wrap: { allowNetwork: options.allowNetwork, extraReadWrite: [], extraReadOnly: [] },
  };
}

export interface ShellEgressStatus {
  sandboxMode: SandboxMode;
  runner: SandboxRunner | null;
  /** `enforced`, `advisory` (proxy variables only), or `not applicable` (no active policy). */
  enforcement: ShellEgressEnforcement | 'not applicable';
  detail: string;
}

/** What the egress policy means for shell commands on this host right now, for the operator. */
export function shellEgressStatus(): ShellEgressStatus {
  const sandboxMode = getSandboxMode();
  const runner = activeSandboxRunner({ mode: sandboxMode });
  if (!egressPolicyActive(activeEgressPolicy())) {
    return { sandboxMode, runner, enforcement: 'not applicable', detail: 'No egress policy is configured: shell commands that ask for network get it unrestricted (inside the sandbox when one is on).' };
  }
  if (runner === 'bwrap' || runner === 'firejail') {
    return { sandboxMode, runner, enforcement: 'enforced', detail: `Shell commands run under ${runner} in a network namespace whose only way out is the egress proxy; commands without network get none.` };
  }
  if (runner === 'sandbox-exec') {
    return { sandboxMode, runner, enforcement: 'enforced', detail: 'Shell commands run under sandbox-exec with outbound TCP allowed only to the egress proxy port.' };
  }
  return {
    sandboxMode, runner, enforcement: 'advisory',
    detail: activeEgressPolicy().requireEnforcement
      ? 'No process sandbox confines shell commands here, and requireEnforcement is set: shell commands are refused.'
      : 'NOT enforced: no process sandbox confines shell commands here, so they keep the host network. They get HTTP(S)_PROXY pointing at the egress proxy, which only well-behaved HTTP clients honour. Set security.shellSandbox to auto or required with bwrap or firejail installed, or set requireEnforcement.',
  };
}

/** One outbound path and how the egress policy holds on it. */
export interface EgressPathStatus {
  path: string;
  enforcement: 'enforced' | 'advisory' | 'partial' | 'not covered' | 'refused' | 'not applicable';
  detail: string;
}

/** The operator's view (GET /api/settings/egress): is a policy active, and what does it hold on this host. */
export function egressEnforcementStatus(): { active: boolean; default: 'allow' | 'deny'; ruleCount: number; requireEnforcement: boolean; paths: EgressPathStatus[] } {
  const policy = activeEgressPolicy();
  const active = egressPolicyActive(policy);
  const scopes = [...Object.values(policy.tools), ...Object.values(policy.roles)];
  const ruleCount = policy.rules.length + scopes.reduce((n, scope) => n + scope.rules.length, 0);
  const shell = shellEgressStatus();
  const uncovered = (path: string, why: string): EgressPathStatus => policy.requireEnforcement
    ? { path, enforcement: 'refused', detail: `Refused under requireEnforcement: ${why}.` }
    : { path, enforcement: 'not covered', detail: `NOT judged by the policy: ${why}.` };
  const paths: EgressPathStatus[] = [
    { path: 'web fetch (websearch page schema, vision, artifact data sources and collectors, plugin web:read; every redirect hop)', enforcement: 'enforced', detail: 'Judged on the canonical host before it is resolved and on the resolved addresses the connection is pinned to; private addresses refused.' },
    { path: 'browser pages (browser, websearch search and fetch_page, visual)', enforcement: 'enforced', detail: 'The browser context is routed through an egress proxy: every request (redirect hops, sub-resources, scripts, clicks) is judged before it is sent. Not through it: WebRTC and the browser\'s DNS prefetch.' },
    { path: 'shell commands', enforcement: shell.enforcement === 'enforced' ? 'enforced' : policy.requireEnforcement ? 'refused' : 'advisory', detail: shell.detail },
    { path: 'git clone/pull/push, github repo_clone', enforcement: 'partial', detail: 'The remote URL git will use (insteadOf applied) is judged with its addresses before git starts; what git then does (HTTP redirects, submodules, LFS) is not.' },
    { path: 'plugin packages (declared network hosts)', enforcement: 'enforced', detail: 'Applied on top of the manifest in the package egress proxy; where a package runs unsandboxed the proxy itself is advisory (see the package status).' },
    ...UNJUDGED_EGRESS.map((u) => uncovered(`${u.tool}: ${u.actions.join(', ')}`, u.why)),
    uncovered(UNJUDGED_CLI_NATIVE_TOOLS, 'their tools run inside the vendor CLI process'),
    { path: 'github tool API calls, websearch through SearXNG, connections tool requests, plugin host collector fetches, operator-configured MCP servers, SSH execution environments', enforcement: 'not covered', detail: 'Fixed or operator/user-configured destinations (the GitHub API, your SearXNG, a configured connection\'s approved origin, an approved repository\'s remotes, servers you configured, a remote host\'s own network), not judged by the tool policy.' },
  ];
  return {
    active, default: policy.default, ruleCount, requireEnforcement: policy.requireEnforcement,
    paths: active ? paths : paths.map((p) => ({ ...p, enforcement: 'not applicable' as const, detail: `No egress policy is configured. When one is: ${p.detail}` })),
  };
}

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
import { join, resolve } from 'node:path';
import { getConfig } from '@/config';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import { ownNodeBinary } from '@/mcp/transports/stdio';
import { coreLogger } from '@/utils/logger';
import { bridgedArgv, type EgressProxy, proxyEnv, startEgressProxy } from './egress-proxy';
import { activeEgressPolicy, currentEgressSubject, egressDecider, egressPolicyActive, type EgressSubject } from './egress-policy';
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

/** Where the proxy's socket directory goes: under the workspace root, which both runners can mount (not /tmp, see `EgressProxyOptions.socketParent`). */
function socketParent(): string | undefined {
  try {
    return join(resolve(getConfig().workspace.rootPath), 'shell-egress');
  } catch (err) {
    coreLogger.debug({ err: (err as Error).message }, 'Shell egress: no workspace root configured; the proxy socket goes under XDG_RUNTIME_DIR or the temp directory');
    return undefined;
  }
}

let advisoryWarned = false;

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
  const proxy = await startEgressProxy({
    label: `shell:${subject.tool ?? 'shell'}`, allowed: [], anyHost: true,
    decide: egressDecider({ ...subject, tool: subject.tool ?? 'shell' }, 'shell-proxy'),
    unixSocket: confined, socketParent: confined ? socketParent() : undefined,
    ...options.proxyOverrides,
  });
  const close = () => { void proxy.close(); };
  if (confined && proxy.socketPath && proxy.socketDir) {
    return {
      argv: bridgedArgv(argv, proxy.socketPath), env: {}, enforcement: 'enforced', proxy, close,
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
  enforcement: 'enforced' | 'advisory' | 'partial' | 'not applicable';
  detail: string;
}

/** The operator's view (GET /api/settings/egress): is a policy active, and what does it hold on this host. */
export function egressEnforcementStatus(): { active: boolean; default: 'allow' | 'deny'; ruleCount: number; requireEnforcement: boolean; paths: EgressPathStatus[] } {
  const policy = activeEgressPolicy();
  const active = egressPolicyActive(policy);
  const scopes = [...Object.values(policy.tools), ...Object.values(policy.roles)];
  const ruleCount = policy.rules.length + scopes.reduce((n, scope) => n + scope.rules.length, 0);
  const off = (path: string): EgressPathStatus => ({ path, enforcement: 'not applicable', detail: 'No egress policy is configured.' });
  const shell = shellEgressStatus();
  return {
    active, default: policy.default, ruleCount, requireEnforcement: policy.requireEnforcement,
    paths: active ? [
      { path: 'web fetch (websearch page schema, vision, plugin web:read; every redirect hop)', enforcement: 'enforced', detail: 'Judged on the canonical host and the resolved addresses the connection is pinned to.' },
      { path: 'browser pages (browser open/navigate, websearch fetch_page)', enforcement: 'partial', detail: 'The URL, every redirect hop and the serving address are judged; a refused page is not returned. Sub-resources a page loads and later clicks inside a page are not judged.' },
      { path: 'shell commands', enforcement: shell.enforcement === 'enforced' ? 'enforced' : 'advisory', detail: shell.detail },
      { path: 'plugin packages (declared network hosts)', enforcement: 'enforced', detail: 'The policy is applied on top of the manifest in the package egress proxy; where a package runs unsandboxed the proxy itself is advisory (see the package status).' },
    ] : [off('web fetch'), off('browser pages'), off('shell commands'), off('plugin packages')],
  };
}

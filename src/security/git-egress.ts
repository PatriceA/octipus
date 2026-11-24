/**
 * The egress policy for git remotes (the `git` tool's clone/pull/push and the
 * `github` tool's repo_clone; docs/EGRESS-POLICY.md#git).
 *
 * git runs as its own process and is not routed through the egress proxy, so
 * the remote is judged before git is started: the URL git will actually use
 * (after `insteadOf` rewriting, which `git ls-remote --get-url` applies
 * without touching the network), its host, its port and its transport —
 * `https`/`http`, or `ssh` for `ssh://` and scp-style `user@host:path`. The
 * host is resolved and judged with its addresses too, so an address rule
 * applies. A transport the policy cannot judge (`git://`, `ext::`, `fd::`,
 * any other `<helper>::`) is refused while a policy is active; a local path
 * is not network and passes.
 *
 * What git does after it starts is not judged: an HTTP redirect it follows,
 * submodules, LFS endpoints.
 */
import { lookup } from 'node:dns/promises';
import { coreLogger } from '@/utils/logger';
import { activeEgressPolicy, currentEgressSubject, EgressDeniedError, type EgressSubject, type EgressTarget, egressPolicyActive, enforceEgress, precheckEgressName, reportEgressDenial } from './egress-policy';

/** A git remote's network target, `null` for a local path, or `unjudgeable` for a transport or spelling the policy cannot judge with certainty. */
export function gitRemoteTarget(spec: string): EgressTarget | null | 'unjudgeable' {
  const remote = spec.trim();
  if (remote.length === 0) return null;
  // A DOS drive path (`C:\\repo`, `C:/repo`) is local, as git reads it on
  // Windows; elsewhere git reads `c:/repo` as ssh to host `c`.
  if (process.platform === 'win32' && /^[a-z]:[\\/]/i.test(remote)) return null;
  if (remote !== spec || /[\s\\\x00-\x1f\x7f]/.test(remote)) return 'unjudgeable';
  if (/^[a-z][a-z0-9+.-]*::/i.test(remote)) return 'unjudgeable';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(remote)?.[1]?.toLowerCase();
  if (scheme) return urlTarget(remote, scheme);
  // git's `url_is_local_not_ssh`: no colon, or a slash before the first
  // colon (or, on Windows, a drive prefix, above): a local path.
  const colon = remote.indexOf(':');
  const slash = remote.indexOf('/');
  if (colon < 0 || (slash >= 0 && slash < colon)) return null;
  return scpTarget(remote);
}

/**
 * An scp-style remote, cut exactly where git cuts it (`host_end` and the
 * separator search in connect.c): brackets, if the host part opens with `[`
 * or `@[`, are removed and their content kept whole; otherwise the host part
 * ends at the FIRST colon. ssh then takes the user up to the LAST `@`.
 * Anything git would read differently from a human — an `@` or `:` in what
 * follows the separator before any `/`, brackets elsewhere, an empty host —
 * is refused rather than guessed.
 */
function scpTarget(remote: string): EgressTarget | 'unjudgeable' {
  const at = remote.indexOf('@[');
  const start = at >= 0 ? at + 1 : 0;
  let hostPart: string;
  let rest: string;
  let bracketed = false;
  if (remote[start] === '[') {
    const close = remote.indexOf(']', start + 1);
    if (close < 0) return 'unjudgeable';
    const sep = remote.indexOf(':', close + 1);
    if (sep !== close + 1) return 'unjudgeable';
    hostPart = remote.slice(0, start) + remote.slice(start + 1, close);
    rest = remote.slice(sep + 1);
    bracketed = true;
  } else {
    const sep = remote.indexOf(':');
    hostPart = remote.slice(0, sep);
    rest = remote.slice(sep + 1);
  }
  if (!bracketed && /[[\]]/.test(hostPart)) return 'unjudgeable';
  // What follows must read as a path: no further `user@host:` before a slash.
  const firstSegment = rest.split('/')[0];
  if (/[@:]/.test(firstSegment)) return 'unjudgeable';
  const lastAt = hostPart.lastIndexOf('@');
  let hostAndPort = lastAt >= 0 ? hostPart.slice(lastAt + 1) : hostPart;
  let port = 22;
  if (bracketed) {
    // `[user@host:port]:path`: one colon is a port; several, an IPv6 address.
    const colons = hostAndPort.split(':').length - 1;
    if (colons === 1) {
      const [h, p] = hostAndPort.split(':');
      if (!/^\d{1,5}$/.test(p) || Number(p) < 1 || Number(p) > 65535) return 'unjudgeable';
      hostAndPort = h;
      port = Number(p);
    }
  } else if (hostAndPort.includes(':')) return 'unjudgeable';
  // A host starting with `-` would be an option to ssh (`-oProxyCommand=`).
  if (!hostAndPort || /[@[\]/]/.test(hostAndPort) || hostAndPort.startsWith('-')) return 'unjudgeable';
  return { host: hostAndPort, port, scheme: 'ssh' };
}

/** An `http(s)://` or `ssh://` remote; anything another URL parser (curl, ssh) could read differently is refused. */
function urlTarget(remote: string, scheme: string): EgressTarget | null | 'unjudgeable' {
  if (scheme === 'file') return null;
  const ssh = scheme === 'ssh' || scheme === 'git+ssh' || scheme === 'ssh+git';
  if (!ssh && scheme !== 'https' && scheme !== 'http') return 'unjudgeable';
  const authority = remote.slice(remote.indexOf('://') + 3).split('/')[0];
  // One `@` at most, and nothing curl or ssh splits differently from WHATWG.
  if ((authority.match(/@/g) ?? []).length > 1 || /[%?#]/.test(authority)) return 'unjudgeable';
  let url: URL;
  try { url = new URL(ssh ? `http://${remote.slice(remote.indexOf('://') + 3)}` : remote); } catch { return 'unjudgeable'; }
  if (!url.hostname || url.hostname.startsWith('-')) return 'unjudgeable';
  return { host: url.hostname, port: url.port ? Number(url.port) : ssh ? 22 : scheme === 'https' ? 443 : 80, scheme: ssh ? 'ssh' : scheme as 'http' | 'https' };
}

/**
 * Judge each URL git would contact, before it starts. No tool call or no
 * policy: nothing to do. Throws `EgressDeniedError` (or a plain refusal for an
 * unjudgeable transport).
 */
export async function enforceGitRemotes(urls: readonly string[], subject: EgressSubject | undefined = currentEgressSubject(), resolveHost: (host: string) => Promise<string[]> = lookupAll): Promise<void> {
  if (!subject || !egressPolicyActive(activeEgressPolicy())) return;
  for (const url of urls) {
    const target = gitRemoteTarget(url);
    if (target === null) continue;
    if (target === 'unjudgeable') {
      const decision = { allowed: false, host: url.slice(0, 80), port: 0, scheme: 'ssh' as const, rule: 'a git transport the egress policy cannot judge' };
      reportEgressDenial(decision, subject, 'git');
      throw new EgressDeniedError(decision, subject);
    }
    precheckEgressName(target, 'git', subject);
    let addresses: string[] | undefined;
    try { addresses = await resolveHost(target.host); }
    catch (err) { coreLogger.debug({ host: target.host, err: (err as Error).message }, 'Egress: git remote does not resolve; judged by name alone'); }
    enforceEgress(target, addresses, 'git', subject);
  }
}

async function lookupAll(host: string): Promise<string[]> {
  return (await lookup(host.replace(/^\[|\]$/g, ''), { all: true, verbatim: true })).map((a) => a.address);
}

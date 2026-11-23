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

/** A git remote's network target, `null` for a local path, or `unjudgeable` for a transport the policy cannot see into. */
export function gitRemoteTarget(spec: string): EgressTarget | null | 'unjudgeable' {
  const remote = spec.trim();
  if (/^[a-z][a-z0-9+.-]*::/i.test(remote)) return 'unjudgeable';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(remote)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === 'file') return null;
    if (scheme !== 'https' && scheme !== 'http' && scheme !== 'ssh' && scheme !== 'git+ssh' && scheme !== 'ssh+git') return 'unjudgeable';
    let url: URL;
    try { url = new URL(scheme.includes('ssh') ? remote.replace(/^[^:]+:/, 'http:') : remote); } catch { return 'unjudgeable'; }
    const ssh = scheme.includes('ssh');
    return { host: url.hostname, port: url.port ? Number(url.port) : ssh ? 22 : scheme === 'https' ? 443 : 80, scheme: ssh ? 'ssh' : scheme as 'http' | 'https' };
  }
  // A Windows drive path (`C:\\repo`, `C:/repo`) is local.
  if (/^[a-z]:[\\/]/i.test(remote)) return null;
  // scp-like `[user@]host:path`: a colon before any slash (git's own rule).
  const scp = /^(?:[^@/]+@)?(\[[^\]]+\]|[^:/]+):(?!\/\/)/.exec(remote);
  if (scp) return { host: scp[1], port: 22, scheme: 'ssh' };
  return null;
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

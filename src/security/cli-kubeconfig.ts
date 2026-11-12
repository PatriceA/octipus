import { executionEnvironmentFor } from './execution-environments';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { load } from 'js-yaml';
import { getConfig } from '@/config';

export interface CliKubeconfig { userId: string; path: string; resolvedPath: string; context: string }
export function inspectCliKubeconfig(path: string): Omit<CliKubeconfig, 'userId'> {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('Choose an absolute kubeconfig file path on the Octipus server.');
  try {
    const resolvedPath = realpathSync(path);
    const stat = statSync(resolvedPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid file');
    const data = load(readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
    const context = data?.['current-context'];
    const contexts = data?.contexts as Array<{ name?: string; context?: { cluster?: string; user?: string } }> | undefined;
    const selected = contexts?.find(entry => entry.name === context)?.context;
    const cluster = (data?.clusters as Array<{ name?: string; cluster?: Record<string, unknown> }> | undefined)?.find(entry => entry.name === selected?.cluster)?.cluster;
    const user = (data?.users as Array<{ name?: string; user?: Record<string, unknown> }> | undefined)?.find(entry => entry.name === selected?.user)?.user;
    if (typeof context !== 'string' || !selected || !cluster || !user || typeof cluster.server !== 'string') throw new Error('Incomplete kubeconfig');
    // Exposing a kubeconfig must not silently expose adjacent private key files.
    if (cluster['certificate-authority'] || user['client-certificate'] || user['client-key'] || user.tokenFile) {
      throw new Error('External credential files');
    }
    return { path, resolvedPath, context };
  } catch {
    throw new Error('Kubeconfig must be a readable file (at most 1 MiB), with a complete current context and embedded credentials/certificate data. External credential files are not mounted.');
  }
}
export function discoverCliKubeconfigs(): Array<Omit<CliKubeconfig, 'userId'>> {
  const paths = [...(process.env.KUBECONFIG ?? '').split(delimiter), join(homedir(), '.kube/config')];
  return [...new Set(paths.filter(Boolean))].flatMap(path => {
    try { return [inspectCliKubeconfig(path)]; } catch { return []; }
  });
}
/** Operator-approved identity is personal; shared spaces and other users never receive it. */
export function withCliKubeconfig<T extends { env?: Record<string, string>; extraReadOnly?: string[]; timeout?: number; allowNetwork?: boolean }>(
  caller: { userId?: string; workspaceId?: string | null; metadata?: Record<string, unknown>; space?: unknown; trigger?: unknown; audienceFederated?: boolean } | undefined, options: T,
): T {
  if (!caller?.userId || caller.space || caller.trigger === 'remote' || caller.audienceFederated) return options;
  const environment = executionEnvironmentFor({ userId: caller.userId, workspaceId: caller.workspaceId, metadata: caller.metadata, space: caller.space });
  if (environment && (environment.backend !== 'host' || !environment.hostIdentity)) return options;
  const entry = (getConfig().security.cliKubeconfigs ?? []).find(entry => entry.userId === caller.userId);
  if (!entry) return options;
  const current = inspectCliKubeconfig(entry.path);
  if (current.resolvedPath !== entry.resolvedPath || current.context !== entry.context) throw new Error('Approved kubeconfig changed. Open Settings → CLI tools and select it again.');
  return { ...options, env: { ...options.env, KUBECONFIG: current.resolvedPath }, extraReadOnly: [...(options.extraReadOnly ?? []), current.resolvedPath] };
}

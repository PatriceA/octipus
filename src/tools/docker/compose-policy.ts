import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/** Compose is executable repository configuration, approved as a whole project. */
export function validateComposeConfig(config: Record<string, unknown>, repo: string, approvedPorts: number[], approvedBindPaths: string[] = []): void {
  void repo;
  const approvedBind = (source: string) => approvedBindPaths.some(root => { const rel = relative(root, source); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); });
  for (const kind of ['volumes', 'networks', 'secrets', 'configs']) {
    for (const resource of Object.values((config[kind] ?? {}) as Record<string, Record<string, unknown>>)) {
      if (resource.external || resource.driver_opts || resource.driver && resource.driver !== 'local' && resource.driver !== 'bridge' || resource.name && !String(resource.name).startsWith(`${config.name}_`)) throw new Error(`Compose ${kind} must be project-owned; external or custom resources are unsupported`);
      if (resource.file || resource.environment) throw new Error('Compose secret/config files and host environment sources are unsupported; use image-contained configuration');
    }
  }
  for (const service of Object.values((config.services ?? {}) as Record<string, Record<string, unknown>>)) {
    const deploy = service.deploy as { resources?: { reservations?: { devices?: unknown } } } | undefined;
    if (deploy?.resources?.reservations?.devices || service.runtime || service.gpus || service.env_file || service.device_cgroup_rules || service.userns_mode || service.cgroup || service.cgroup_parent || service.security_opt || service.privileged || service.network_mode || service.pid || service.ipc || service.devices || service.cap_add || service.volumes_from || service.container_name || service.use_api_socket || service.develop || service.provider || service.post_start || service.pre_stop) throw new Error('Compose host privileges, shared namespaces and custom container names are unsupported');
    for (const volume of (service.volumes ?? []) as { type?: string; source?: string }[]) {
      if (volume.type === 'bind' && (!volume.source || !approvedBind(volume.source))) throw new Error('Compose bind source requires an explicitly approved host path in approvedBindPaths');
    }
    const build = service.build as Record<string, unknown> | undefined;
    if (build) throw new Error('Compose inline builds are unsupported; build images with the approved build_image tool first');
    for (const port of (service.ports ?? []) as { published?: string | number; host_ip?: string }[]) {
      if (!/^\d+$/.test(String(port.published)) || !approvedPorts.includes(Number(port.published))) throw new Error(`Compose published port ${port.published ?? '(dynamic)'} requires explicit approvedPorts consent`);
    }
  }
}

/** Lexical containment is insufficient for repository symlinks. */
export async function validateComposeFilesystem(config: Record<string, unknown>, repo: string): Promise<void> {
  const check = async (path: string) => {
    const actual = await realpath(resolve(repo, path));
    const rel = relative(repo, actual);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Compose host files must resolve inside the approved repository');
  };
  for (const kind of ['secrets', 'configs']) {
    for (const resource of Object.values((config[kind] ?? {}) as Record<string, { file?: string }>)) if (resource.file) await check(resource.file);
  }
  for (const service of Object.values((config.services ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const volume of (service.volumes ?? []) as (string | { type?: string; source?: string })[]) {
      if (typeof volume !== 'string' && volume.type === 'bind' && volume.source) await realpath(volume.source);
    }
    for (const file of (service.env_file ?? []) as (string | { path: string })[]) await check(typeof file === 'string' ? file : file.path);
    const build = service.build as { context: string; dockerfile?: string } | undefined;
    if (build) { await check(build.context); await check(resolve(build.context, build.dockerfile ?? 'Dockerfile')); }
  }
}

/** Reject imports before Compose can read outside files or erase their provenance. */
export async function validateRawCompose(file: string, repo: string): Promise<string> {
  const { readFile, lstat } = await import('node:fs/promises');
  const { load } = await import('js-yaml');
  const stat = await lstat(file);
  if (stat.size > 1_048_576) throw new Error('Compose configuration exceeds 1 MiB');
  const text = await readFile(file, 'utf8');
  if (Buffer.byteLength(text) > 1_048_576) throw new Error('Compose configuration exceeds 1 MiB');
  let raw: Record<string, unknown>;
  try { raw = load(text) as Record<string, unknown>; } catch { throw new Error('Invalid Compose YAML; parser excerpts are omitted to protect credential values'); }
  if (!raw || typeof raw !== 'object' || raw.include) throw new Error('Compose include is unsupported; keep configuration in the approved repository');
  for (const service of Object.values((raw.services ?? {}) as Record<string, Record<string, unknown>>)) if (service.extends) throw new Error('Compose extends is unsupported; keep configuration in the approved repository');
  // Reject imports and host-file consumers before Docker parses the raw file.
  for (const service of Object.values((raw.services ?? {}) as Record<string, Record<string, unknown>>)) {
    if (service.env_file || service.build) throw new Error('Compose env_file and inline builds are unsupported; use image-contained configuration and prebuilt images');
  }
  for (const kind of ['secrets', 'configs']) for (const resource of Object.values((raw[kind] ?? {}) as Record<string, Record<string, unknown>>)) if (resource.file || resource.environment) throw new Error('Compose host secret/config sources are unsupported');
  return text;
}

/** Canonicalize explicitly consented host bind sources before snapshot execution. */
export async function resolveComposeBindPaths(config: Record<string, unknown>, approvedPaths: string[]): Promise<string[]> {
  const approved = await Promise.all(approvedPaths.map(path => realpath(path)));
  for (const service of Object.values((config.services ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const volume of (service.volumes ?? []) as { type?: string; source?: string }[]) if (volume.type === 'bind' && volume.source) volume.source = await realpath(volume.source);
  }
  return approved;
}

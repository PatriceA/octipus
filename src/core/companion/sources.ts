import type { AttachedFileRef } from '@/core/session-files';
import type { WorkspaceFS } from '@/security/workspace-fs';

/** Resolve in the source's scope before forwarding. Resolving a relative
 * attachment against the backend cwd could grant an unrelated host file. */
export function companionSourceFiles(fs: WorkspaceFS, refs: AttachedFileRef[]): AttachedFileRef[] {
  return refs.map(({ path, version, protectionLevel }) => ({ path: fs.resolve(path),
    ...(version === undefined ? {} : { version }), ...(protectionLevel === undefined ? {} : { protectionLevel }) }));
}

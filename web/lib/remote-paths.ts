/**
 * Paths of `/api/remote-spaces` (federation §8.3), and the id checks for
 * what the host sends back. Pure: no React, no fetch, so it is tested on
 * its own (src/core/federation/remote-paths.test.ts).
 *
 * Every id in a remote space comes from another install. A path is built
 * from segments, each one `encodeURIComponent`ed — a host id of `../admin`
 * or `x?y` stays one segment of this install's route — and rows whose id
 * is not a UUID are dropped before a view keys, links or pages by them.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** `/remote-spaces/<id>/<segment>/…`, every segment encoded; `query` (already built) after `?`. */
export function remotePath(remoteSpaceId: string, segments: readonly string[] = [], query?: string): string {
  const path = ['remote-spaces', remoteSpaceId, ...segments].map((s) => encodeURIComponent(s)).join('/');
  return `/${path}${query ? `?${query}` : ''}`;
}

/** A file of the space by its path there: each `/`-separated part its own encoded segment; empty, `.` and `..` parts refused. */
export function remoteFilePath(remoteSpaceId: string, filePath: string): string {
  const parts = filePath.split('/').filter((p) => p !== '');
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) throw new Error(`Not a file path: ${filePath}`);
  return remotePath(remoteSpaceId, ['files', ...parts]);
}

/** The rows whose `id` is a UUID: what a view may key, link or page by. */
export function withUuidIds<T extends { id: unknown }>(rows: readonly T[] | null | undefined): T[] {
  return (rows ?? []).filter((row) => isUuid(row.id));
}

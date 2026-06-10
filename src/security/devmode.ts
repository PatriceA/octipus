/**
 * devMode authorization policy.
 *
 * devMode points the agent's filesystem tools and the CLI worker at an
 * arbitrary host path supplied by the caller (`projectPath`). That is the
 * intended "open my repo" behavior for a single-user / local self-hosted
 * install — but on a shared multiuser instance it is a full filesystem
 * sandbox escape: any authenticated user could send
 * `{ devMode: true, projectPath: '/etc' }` (or another tenant's directory)
 * and have the agent read/write there, because `projectPath` is granted as
 * an extra-allowed prefix to the filesystem tool and as the CLI worker cwd.
 *
 * Policy: honor request-supplied devMode/projectPath only when the caller is
 * an admin (the operator). For any non-admin the ingestion sites drop devMode +
 * projectPath so it never reaches session context, and every downstream
 * consumer is safe by construction.
 */
export function devModeAllowed(isAdmin: boolean): boolean {
  return isAdmin;
}

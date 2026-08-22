/**
 * The environment handed to a spawned process.
 *
 * A child inherits the whole of `process.env` by default, which is every
 * provider API key, the master key, the JWT and session secrets and the
 * database URL. One `env`-dumping command, one `docker run --env`, one CI
 * script that echoes its environment, and they are in the model's context and
 * in the transcript.
 *
 * So the default is to strip anything that smells like a credential and let a
 * caller that genuinely needs one name it. The two mistakes are not
 * symmetrical: over-stripping costs one explicit pass-through at the call
 * site, under-stripping puts a secret somewhere it can be read.
 */

/** Octipus's own root secrets — never leak these into spawned commands. */
const SENSITIVE_ENV_EXACT = new Set([
  'MASTER_KEY',
  'JWT_SECRET',
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'POSTGRES_PASSWORD',
]);

/**
 * Provider/channel credentials and anything that smells like a secret.
 *
 * Deliberately a substring match, not a suffix one: the anchored version read
 * `AWS_SECRET_ACCESS_KEY` as safe because its name ends in ACCESS_KEY rather
 * than in SECRET, and passed it straight to every spawned command.
 */
const SENSITIVE_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

export interface ChildEnvOptions {
  /**
   * Names to carry through from `process.env` even though they look sensitive
   * — a tool's own credential, e.g. `GH_TOKEN` for `gh`. Keep these lists
   * short and specific to the binary being run.
   */
  keep?: readonly string[];
}

/**
 * Does this variable name look like a credential?
 *
 * Exported so the same judgment covers reading a variable and passing one on:
 * the `env` tool answers by name, and a name-by-name read is a credential leak
 * with extra steps if it does not consult this.
 */
export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_EXACT.has(name) || SENSITIVE_ENV_PATTERN.test(name);
}

/** Build the environment for a spawned child. */
export function buildChildEnv(
  extra?: Record<string, string>,
  opts: ChildEnvOptions = {},
): Record<string, string> {
  const keep = new Set(opts.keep ?? []);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (!keep.has(k) && isSensitiveEnvName(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

/**
 * An agent installs the plugin it wrote (creator mode,
 * docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent): the same install
 * path as an admin's (`installFromDirectory`), with what an agent may not do
 * taken away.
 *
 * - **Admins only.** An agent installs for the user it works for, and only an
 *   admin installs plugins; a non-admin's agent is refused and told to ask an
 *   admin. The call itself is a `write` the user approves (the tool's
 *   permission), so nothing installs without that admin saying yes.
 * - **Never in-process.** Only the sandboxed `package` runtime: an agent never
 *   gets code into the server process.
 * - **Always disabled.** Like every install; there is no tool to enable or
 *   approve. An admin reviews the content hash on the admin page and enables
 *   it, so Octipus does not start what the agent wrote before a person
 *   approved those bytes. (The agent's shell is another matter: it runs code
 *   only in the shell sandbox when that is on, and asks for each command.)
 * - **Only its own.** An upgrade replaces only a package whose current
 *   version an agent installed, never one a person installed.
 * - **Recorded.** The `installed`/`upgraded` audit row carries `authoredBy`
 *   (the user, session and agent), which the admin page shows.
 *
 * The caller (src/tools/plugin-dev) resolves the directory inside the agent's
 * workspace; this module checks everything else.
 */
import { getDb } from '@/db/postgres';
import { userRepository } from '@/db/repositories/user-repository';
import { pluginPackages } from '@/db/schema/plugin-packages';
import type { PluginManifest } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';
import { installFromDirectory, PluginPackageError } from '../service';
import { bundledDir } from '../bundled';
import { agentAuthorship } from './authorship';
import { IN_PROCESS_REFUSAL, type PluginValidation, validatePluginDirectory } from './validate';

export interface AgentInstallRequest {
  /** The package directory, already resolved inside the agent's workspace. */
  dir: string;
  userId: string;
  sessionId: string | null;
  agentId: string | null;
  upgrade?: boolean;
  /** Where the admin reviews and enables it, for the answer. */
  adminPage: string;
}

export type AgentInstallResult =
  | {
    installed: true;
    name: string;
    version: string;
    enabled: false;
    upgraded: boolean;
    contentHash: string;
    signedBy: string | null;
    warnings: string[];
    review: string;
  }
  | { installed: false; error: string; problems?: string[] };

/** Whether the user is an active admin (who may install plugins). */
export async function isActiveAdmin(userId: string): Promise<boolean> {
  const user = await userRepository.findById(userId).catch(() => null);
  return user?.isAdmin === true && user.isActive !== false;
}

/** The installed packages, for the command-name checks of a validation. */
export async function installedForValidation(): Promise<Array<{ name: string; version: string; manifest: PluginManifest }>> {
  return getDb().select({ name: pluginPackages.name, version: pluginPackages.version, manifest: pluginPackages.manifest }).from(pluginPackages);
}

/**
 * Whether `name` is a plugin shipped with Octipus (`plugins/<name>`): an agent
 * may not install a package under that name, so it cannot stand in for one.
 * TODO: switch to `isBundledName` from ../bundled once it is exported there.
 */
function isBundledName(name: string): boolean {
  return bundledDir(name) !== null;
}

const refused = (error: string, problems?: string[]): AgentInstallResult => ({ installed: false, error, ...(problems?.length ? { problems } : {}) });

/** Install the package in `req.dir` for the agent, disabled. Refusals come back as `{ installed: false, error }`. */
export async function installAgentPlugin(req: AgentInstallRequest): Promise<AgentInstallResult> {
  if (!await isActiveAdmin(req.userId)) {
    return refused('Only an admin can install plugins. The package is ready in your workspace: ask an admin to install it '
      + '(Admin → Plugin packages, or POST /api/plugin-packages { "path": … }) and review its content hash before enabling it.');
  }
  const installed = await installedForValidation();
  const validation: PluginValidation = await validatePluginDirectory(req.dir, installed);
  if (validation.problems.includes(IN_PROCESS_REFUSAL)) return refused(IN_PROCESS_REFUSAL);
  if (!validation.ok || !validation.name) return refused('The package does not validate; fix every problem and run plugin_validate again', validation.problems);

  const current = installed.find((p) => p.name === validation.name);
  if (current && !req.upgrade) {
    return refused(`${validation.name} is already installed (version ${current.version}); pass upgrade: true to replace it`);
  }
  if (!current && req.upgrade) return refused(`${validation.name} is not installed; install it without upgrade`);
  if (isBundledName(validation.name)) {
    return refused(`${validation.name} is the name of a plugin shipped with Octipus; an agent may not take it. Choose another name.`);
  }
  if (current) {
    const author = await agentAuthorship(current.name);
    if (!author) {
      return refused(`${validation.name} was installed by a person; an agent may replace only a package an agent installed. Choose another name.`);
    }
    if (author.userId !== req.userId) {
      return refused(`${validation.name} was installed by another user's agent; an agent may replace only a package installed by an agent of the same user. Choose another name.`);
    }
  }

  try {
    const row = await installFromDirectory(req.dir, req.userId, {
      upgrade: !!current,
      // What was validated above is the agent's directory, which it may still
      // change: the install reads and checks its own copy, and refuses one
      // that is not the package checked here or not a sandboxed package.
      requireRuntime: 'package',
      expect: { name: validation.name, ...(validation.version ? { version: validation.version } : {}) },
      authoredBy: { kind: 'agent', userId: req.userId, sessionId: req.sessionId, agentId: req.agentId },
    });
    coreLogger.info({ pkg: row.name, version: row.version, userId: req.userId, sessionId: req.sessionId }, 'Plugin package installed by an agent (disabled)');
    return {
      installed: true,
      name: row.name,
      version: row.version,
      enabled: false,
      upgraded: !!current,
      contentHash: row.contentHash ?? '',
      signedBy: row.signedBy,
      warnings: [...validation.warnings.filter((w) => !w.includes('is installed (version')), ...row.warnings],
      review: `Installed disabled. Octipus does not start it until an admin reviews it and enables it: open ${req.adminPage}, check that ${row.name} `
        + `shows content hash ${row.contentHash} and "Authored by an agent", read its tools, effects and hosts, set any required settings `
        + `and secrets, approve what it adds for every user (commands, schedules, events, prompt, context) if anything, then enable it (or: octi plugin list, then PATCH /api/plugin-packages/${row.name} { "enabled": true }).`,
    };
  } catch (err) {
    if (err instanceof PluginPackageError) return refused(err.message, err.problems.length > 1 || err.problems[0] !== err.message ? err.problems : undefined);
    throw err;
  }
}

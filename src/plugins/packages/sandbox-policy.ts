/**
 * The sandbox of plugin package servers (docs/PLUGIN-PACKAGES.md#the-sandbox).
 *
 * One of the four hard boundaries: a `package` plugin runs in a sandbox
 * runner (bwrap or firejail on Linux, sandbox-exec on macOS, AppContainer on Windows) with its own
 * files read-only, one writable data directory and no direct network, so it
 * cannot read the server's environment (`/proc/<ppid>/environ`: the database
 * URL, the master key), files or network.
 *
 * Decoupled from `security.shellSandbox` (agent shells), which defaults to
 * off: `plugins.sandbox` decides, and defaults to `required`.
 *
 * - `required`: a package plugin never starts without a working runner;
 *   enabling it and consenting to it are refused too, naming what is missing.
 * - `off`: a plugin NOT from the marketplace runs unwrapped, as the server's
 *   user. Plainly warned.
 * - A plugin from the marketplace (`origin.source === 'marketplace'`) always
 *   needs a runner, whatever the setting.
 *
 * What the admin is told (declarations, the network status, the admin page)
 * is computed from the same state, so nothing says "sandboxed" or "no
 * network" where that is not enforced on this host.
 */
import { getConfig } from '@/config';
import { pluginRunnerState, type SandboxRunner } from '@/security/shell-sandbox';
import type { PluginOrigin, PluginSandboxStatus } from '@/shared/plugin-package';
import { coreLogger } from '@/utils/logger';

export type PluginSandboxSetting = 'required' | 'off';

/** `plugins.sandbox`; `required` when config is not loaded. */
export function pluginSandboxSetting(): PluginSandboxSetting {
  try {
    return getConfig().plugins?.sandbox === 'off' ? 'off' : 'required';
  } catch {
    return 'required';
  }
}

/** The host side: the setting, and the runner that works here (or why none does). */
export interface PluginSandboxHost {
  setting: PluginSandboxSetting;
  runner: SandboxRunner | null;
  /** Why no runner works here; null when one does. */
  unavailable: string | null;
}

export function pluginSandboxHost(): PluginSandboxHost {
  const state = pluginRunnerState();
  return { setting: pluginSandboxSetting(), runner: state.runner, unavailable: state.problem };
}

/** How one package's server runs on this host. */
export interface PluginSandboxPlan {
  /** A runner is required for it (`plugins.sandbox: required`, or it comes from the marketplace). */
  required: boolean;
  /** The runner it runs in; null when it runs unwrapped (`off`) or may not start. */
  runner: SandboxRunner | null;
  /** Why it may not start (a runner is required and none works here); null when it may. */
  problem: string | null;
}

/** How a package of `origin` runs here. */
export function pluginSandboxPlan(origin: Pick<PluginOrigin, 'source'> | null | undefined, host: PluginSandboxHost = pluginSandboxHost()): PluginSandboxPlan {
  const marketplace = origin?.source === 'marketplace';
  const required = marketplace || host.setting === 'required';
  if (!required) return { required, runner: null, problem: null };
  if (host.runner) return { required, runner: host.runner, problem: null };
  const why = marketplace ? 'a plugin from the marketplace always runs in a sandbox' : 'plugins.sandbox is required';
  return { required, runner: null, problem: `Not sandboxed on this host, so it does not run (${why}): ${host.unavailable ?? 'no sandbox runner'}` };
}

/** What the declarations say about the runtime and network on this host (`declarationItems`). */
export interface PluginHostEnforcement {
  /** The runner that wraps the server, or null (unwrapped, or refused). */
  runner: string | null;
  /** Why it may not start here, or null. */
  refused: string | null;
}

/** `pluginSandboxPlan` as the declarations need it. */
export function hostEnforcement(origin: Pick<PluginOrigin, 'source'> | null | undefined, host: PluginSandboxHost = pluginSandboxHost()): PluginHostEnforcement {
  const plan = pluginSandboxPlan(origin, host);
  return { runner: plan.runner, refused: plan.problem };
}

/** The state for the admin page and the startup log (`GET /api/plugin-packages/sandbox`). */
export function pluginSandboxView(host: PluginSandboxHost = pluginSandboxHost()): PluginSandboxStatus {
  const summary = host.runner
    ? `active runner ${host.runner}`
    : `unavailable: ${host.unavailable ?? 'no sandbox runner'}${host.setting === 'off'
      ? ' (plugins.sandbox is off: local plugins run unsandboxed; marketplace plugins do not run)'
      : ' (plugin packages do not run)'}`;
  return { setting: host.setting, runner: host.runner, unavailable: host.unavailable, platform: process.platform, summary };
}

/** The startup log line: which runner plugin servers get, or why none. */
export function logPluginSandboxState(): void {
  const view = pluginSandboxView();
  if (view.runner) coreLogger.info({ runner: view.runner, setting: view.setting }, `Plugin sandbox: ${view.summary}`);
  else coreLogger.warn({ setting: view.setting, unavailable: view.unavailable }, `Plugin sandbox: ${view.summary}`);
}

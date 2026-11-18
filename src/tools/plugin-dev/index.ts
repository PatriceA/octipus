import { protectionView } from '@/plugins/packages/protection-policy';
import { findRow } from '@/plugins/packages/service';
/**
 * plugin_dev — creator mode, sandboxed (docs/plans/plugins-everything.md
 * phase 4, docs/PLUGIN-PACKAGES.md#writing-a-plugin-with-an-agent): an agent
 * writes a `package` plugin in its workspace and installs it disabled, for an
 * admin to review and enable.
 *
 * - `plugin_api` (read): the live contract — manifest schema, events,
 *   effects, limits, the MCP stdio contract, the environment and sandbox.
 * - `plugin_template` (read): the templates, and one template's files to
 *   write into the workspace with the filesystem tool. A read rather than a
 *   scaffolding write: the filesystem tool already decides where an agent's
 *   files go (session directory, project) and asks for its writes.
 * - `plugin_validate` (read): every problem an install would refuse, without
 *   installing.
 * - `plugin_install` (write, ASK, admins only): installs a package from the
 *   agent's workspace, disabled, recording the agent as its author.
 *
 * There is no tool to enable or approve a plugin: that stays a person's
 * action on the admin page or the CLI.
 */
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getConfig } from '@/config';
import { publicLinkBase } from '@/core/public-url';
import { ToolNotExecutedError } from '@/core/tool-execution-error';
import type { AgentContext, ToolManifest } from '@/core/types';
import { PLUGIN_DEV_TOOL_ID, PLUGIN_DEV_TOOLS, pluginApiContract } from '@/plugins/packages/authoring/contract';
import { installAgentPlugin, installedForValidation, isActiveAdmin } from '@/plugins/packages/authoring/install';
import { listTemplates, readTemplate } from '@/plugins/packages/authoring/templates';
import { validatePluginDirectory } from '@/plugins/packages/authoring/validate';
import { networkStatus } from '@/plugins/packages/service';
import { pluginCapabilityPreflight } from '@/plugins/packages/authoring/preflight';
import { executionEnvironmentFor } from '@/security/execution-environments';
import { isInside, userWorkspacesDir } from '@/security/workspace-fs';
import { toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema } from '../base-tool';
import { filesystemTool } from '../filesystem';

/** Where an admin reviews and enables plugin packages. */
export function adminPluginsPage(): string {
  return `${publicLinkBase()}/admin/plugins`;
}

/** The directories of the plugin store: never a source for an agent's install. */
function pluginStoreDirs(): string[] {
  const root = resolve(getConfig().workspace.rootPath);
  return ['plugin-packages', 'plugin-data', 'plugin-downloads', 'plugin-run'].map((d) => join(root, d));
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/**
 * The package directory an agent names, resolved like the filesystem tool
 * resolves its reads. Sources may be in the caller's own Octipus workspaces
 * or the selected environment's explicitly approved folders. Account-wide
 * filesystem access alone does not approve every host directory as a plugin
 * source. Other users' data, shared-space data and installed plugin files
 * remain excluded, including through symlinks or an approved parent folder.
 */
export function workspacePackageDir(rawPath: unknown, context: AgentContext): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) throw new ToolNotExecutedError(PLUGIN_DEV_TOOL_ID, 'path: the plugin directory in your workspace');
  const environment = executionEnvironmentFor(context);
  if (environment?.backend === 'ssh') {
    throw new ToolNotExecutedError(PLUGIN_DEV_TOOL_ID, 'Your files are in a remote environment; plugin tools read the Octipus host\'s workspace only. Write the plugin in a session without a remote environment.');
  }
  const { path, root } = filesystemTool.resolveForRead(rawPath.trim(), context);
  const workspace = real(root);
  const dir = real(path);
  const own = real(userWorkspacesDir(context.userId));
  const users = real(dirname(dirname(userWorkspacesDir(context.userId))));
  const spaces = [getConfig().workspace.rootPath, getConfig().workspace.documentsPath]
    .map(folder => real(join(folder, 'spaces')));
  const approved = environment?.roots.some(folder => isInside(real(folder), dir)) === true;
  const personal = isInside(own, dir) && dir !== own;
  const privateData = (isInside(users, dir) && !personal) || isInside(dir, users)
    || spaces.some(folder => isInside(folder, dir) || isInside(dir, folder));
  if (privateData) {
    throw new ToolNotExecutedError(PLUGIN_DEV_TOOL_ID, `${rawPath} is not a directory inside your own workspace: protected Octipus user/shared data and directories containing it cannot be plugin sources`);
  }
  if ((!personal && !approved) || (!approved && dir === workspace) || dir === own) {
    throw new ToolNotExecutedError(PLUGIN_DEV_TOOL_ID, `${rawPath} is not a directory inside your own workspace (${own}) or approved environment folders; choose a project folder in Settings → Environments & Access`);
  }
  if (pluginStoreDirs().some((store) => isInside(real(store), dir) || isInside(dir, real(store)))) {
    throw new ToolNotExecutedError(PLUGIN_DEV_TOOL_ID, `${rawPath} is in the plugin store; point at the copy you wrote in your workspace`);
  }
  return dir;
}

export class PluginDevTool extends BaseTool {
  readonly id = PLUGIN_DEV_TOOL_ID;
  readonly name = 'Plugin authoring';
  readonly version = '1.0.0';
  readonly description = 'Write, check and install sandboxed Octipus plugin packages (installed disabled; an admin enables them).';

  getManifest(): ToolManifest {
    return {
      execution: { kind: 'host' },
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'read', description: 'Read the plugin contract and templates, and validate a plugin directory', defaultLevel: 'ALLOW' },
        // A package that runs code on this host, once an admin enables it: asked every time, never allowed by a broad rule.
        { action: 'write', description: 'Install a plugin package from your workspace, disabled, for an admin to review and enable', defaultLevel: 'ASK', dangerous: true },
      ],
      tools: [
        { name: PLUGIN_DEV_TOOLS.api, description: 'The live plugin package contract', parameters: { installedPlugin: { type:'string',description:'Inspect current owner data approval for this installed package (admins only)' }, needs: { type: 'object', description: 'Requested protectionLevel, interface and host scopes: compatibility before building' } }, returns: 'Manifest JSON schema, events, effects, limits, MCP contract, environment, sandbox, templates' },
        { name: PLUGIN_DEV_TOOLS.template, description: 'List the plugin templates, or return one template\'s files', parameters: { name: { type: 'string', description: 'Template name' } }, returns: 'Templates, or one template\'s files' },
        { name: PLUGIN_DEV_TOOLS.validate, description: 'Validate a plugin directory in your workspace without installing it', parameters: { path: { type: 'string', description: 'Plugin directory', required: true } }, returns: 'ok, problems, warnings, content hash' },
        { name: PLUGIN_DEV_TOOLS.install, description: 'Install a plugin package from your workspace, disabled (admins only, asks first)', parameters: { path: { type: 'string', description: 'Plugin directory', required: true } }, returns: 'The installed package, its content hash and how an admin enables it' },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      PLUGIN_DEV_TOOLS.api,
      'The live contract for writing an Octipus plugin package: the manifest JSON schema, rules the schema cannot express, '
        + 'tool effects, contribution kinds (commands, schedules with cron syntax, events, prompt, context), limits, the MCP stdio '
        + 'contract, the environment variables a package gets, the sandbox and network rules on this host, the templates, and '
        + 'whether you may install (youCanInstall). With installedPlugin, inspect its current data access before recommending a code change.',
      createParameterSchema({ installedPlugin: { type: 'string', description: 'Installed package name: admins can inspect current data approval, supported maximum and the user guidance link.' }, needs: { type: 'object', description: 'Before building: {protectionLevel:1..4, interface:page|dashboard|tools|protected, host:[required host scopes]}. Checks compatibility without lowering classification.' } }),
      async (args, context) => {
        const canInstall=await isActiveAdmin(context.userId);
        let dataAccess:unknown={guide:'docs/PLUGIN-DATA-ACCESS.md',settings:'/admin/plugins',instruction:'Check Data access before proposing package changes. Keep the real classification and existing conversation.'};
        if(args.installedPlugin!==undefined) {
          if(typeof args.installedPlugin!=='string'||!/^[a-z][a-z0-9-]{1,49}$/.test(args.installedPlugin))throw new Error('installedPlugin must be an installed package name.');
          if(!canInstall) dataAccess={guide:'docs/PLUGIN-DATA-ACCESS.md',instruction:'An administrator can inspect and change this package’s Data access. Do not self-approve.'};
          else {const row=await findRow(args.installedPlugin);if(!row)throw new Error('This plugin is not installed.');dataAccess={...await protectionView(row),guide:'docs/PLUGIN-DATA-ACCESS.md',settings:`/admin/plugins?dataAccess=${encodeURIComponent(row.name)}`};}
        }
        return { dataAccess, ...await pluginApiContract({
        canInstall,
        network: (m) => networkStatus(m),
        adminPage: adminPluginsPage(),
      }), ...(args.needs !== undefined ? { preflight: pluginCapabilityPreflight(args.needs) } : {}) };
      },
      { permissionAction: 'read', readOnly: true },
    );

    this.registerTool(
      PLUGIN_DEV_TOOLS.template,
      'Without name: the plugin templates (tool-only, with-schedule, with-command, …). With name: that template\'s files '
        + '(path → text), a complete valid package. Write each file into a new directory of your workspace with the filesystem '
        + 'tool, then rename the package (manifest "name", and NAME in server.mjs) and edit it.',
      createParameterSchema({
        name: { type: 'string', description: 'The template to read; leave out to list them' },
      }),
      async (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (!name) return { templates: await listTemplates() };
        const template = await readTemplate(name);
        if (!template) {
          throw new ToolNotExecutedError(this.id, `No template "${name}"; the templates are ${(await listTemplates()).map((t) => t.name).join(', ')}`);
        }
        return {
          ...template,
          next: 'Write every file under one new directory in your workspace (filesystem write_file), give the package its own name, '
            + 'implement its tools, then plugin_validate that directory.',
        };
      },
      { permissionAction: 'read', readOnly: true },
    );

    this.registerTool(
      PLUGIN_DEV_TOOLS.validate,
      'Validate a plugin package directory in your workspace or approved environment folders without installing it: the manifest against the contract, its '
        + 'contributions (tools it names, cron, command names in use), the tree (no links or special files, size), and that '
        + 'the files its server starts from are in the package. Returns every problem at once, warnings, and the content hash '
        + 'an install would record.',
      createParameterSchema({
        path: { type: 'string', description: 'The plugin directory (holding octipus-plugin.json), as you wrote it with the filesystem tool', required: true },
      }),
      async (args, context) => {
        const dir = workspacePackageDir(args.path, context);
        let installed: Awaited<ReturnType<typeof installedForValidation>> = [];
        const warnings: string[] = [];
        try {
          installed = await installedForValidation();
        } catch (err) {
          toolLogger.warn({ err }, 'plugin_validate: installed packages could not be read');
          warnings.push('The installed packages could not be read: command names were not checked against them');
        }
        const result = await validatePluginDirectory(dir, installed);
        return { path: dir, ...result, warnings: [...result.warnings, ...warnings] };
      },
      { permissionAction: 'read', readOnly: true },
    );

    this.registerTool(
      PLUGIN_DEV_TOOLS.install,
      'Install a validated plugin package (runtime "package") from your workspace. It is installed DISABLED: Octipus does not '
        + 'start it until an admin reviews its content hash on the admin page and enables it — tell the user that. Asks the user '
        + 'for approval; only an admin\'s agent may install. Never installs runtime "in-process". With upgrade: true it replaces '
        + 'a package an agent of the same user installed (disabled again); never one a person or another user\'s agent installed, nor the name of a plugin shipped with Octipus. Only a directory in your own workspace or explicitly approved environment folders.',
      createParameterSchema({
        path: { type: 'string', description: 'The plugin directory in your workspace or approved environment folders', required: true },
        upgrade: { type: 'boolean', description: 'Replace the installed version of a package an agent installed' },
      }),
      async (args, context) => {
        const dir = workspacePackageDir(args.path, context);
        if (context.space) throw new ToolNotExecutedError(this.id, 'Plugins are installed for the whole server; not from a shared space.');
        return installAgentPlugin({
          dir,
          userId: context.userId,
          sessionId: /^[0-9a-f-]{36}$/i.test(context.sessionId ?? '') ? context.sessionId : null,
          agentId: context.id ?? null,
          upgrade: args.upgrade === true,
          adminPage: adminPluginsPage(),
        });
      },
      { requiresPermission: true, permissionAction: 'write' },
    );
  }
}

/** Auto-discovered singleton (see src/tools/discovery.ts). */
export const pluginDevTool = new PluginDevTool();

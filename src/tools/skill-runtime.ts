import type { AgentContext, ToolManifest } from '@/core/types';
import type { ToolHandler } from '@/core/agent-base';
import { BaseTool } from './base-tool';
import { readSkillResource } from '@/skills/resources';
import { runSkillScript } from '@/skills/script-runner';

const resourceParameters = { type: 'object', properties: {
  skill_id: { type: 'string' }, path: { type: 'string', description: 'Relative bundle file or directory, e.g. schemas/common.schema.json or examples.' },
}, required: ['skill_id', 'path'] };
const scriptParameters = { type: 'object', properties: {
  skill_id: { type: 'string' }, script: { type: 'string', description: 'Relative packaged .mjs/.js/.cjs/.py entry point. No inline code.' },
  args: { type: 'array', items: { type: 'string' }, description: 'Script arguments, not a shell command. Use absolute workspace paths for inputs and outputs.' },
  cwd: { type: 'string', description: 'Working directory within the session workspace; defaults to its root.' },
}, required: ['skill_id', 'script'] };

class SkillRuntimeTool extends BaseTool {
  readonly id = 'skill_runtime';
  readonly name = 'Skill resources and scripts';
  readonly version = '1.0.0';
  readonly description = 'Read visible skill bundles and run assigned skill scripts in an offline sandbox.';
  getManifest(): ToolManifest {
    return { id: this.id, name: this.name, version: this.version, description: this.description,
      permissions: [
        { action: 'read', defaultLevel: 'ALLOW', description: 'Read supporting files within a user-visible skill bundle' },
        { action: 'execute', defaultLevel: 'ALLOW', description: 'Run a role-assigned skill script with no network, no credentials, and only its workspace writable' },
      ], tools: [] };
  }
  protected async registerTools(): Promise<void> {
    this.registerTool('read_resource', this.description, resourceParameters, async (args, context) => {
      if (typeof args.skill_id !== 'string' || typeof args.path !== 'string') throw new Error('skill_id and path must be strings.');
      return readSkillResource(args.skill_id, args.path, context.userId);
    }, { permissionAction: 'read', readOnly: true, injectSecrets: false });
    this.registerTool('run_script', this.description, scriptParameters, async (args, context) => {
      if (typeof args.skill_id !== 'string' || typeof args.script !== 'string'
        || (args.cwd !== undefined && typeof args.cwd !== 'string')
        || (args.args !== undefined && (!Array.isArray(args.args) || args.args.some(arg => typeof arg !== 'string')))) {
        throw new Error('Expected skill_id, script, optional cwd strings and an array of string args.');
      }
      const argv = (args.args ?? []) as string[];
      if (argv.length > 100 || argv.join('').length > 32_768) throw new Error('Skill arguments exceed the execution limit.');
      return runSkillScript(args.skill_id, args.script, argv, args.cwd as string | undefined, context);
    }, { permissionAction: 'execute', injectSecrets: false });
  }
}

let runtime: Promise<SkillRuntimeTool> | undefined;
async function execute(name: string, args: Record<string, unknown>, context: AgentContext): Promise<unknown> {
  runtime ??= (async () => { const tool = new SkillRuntimeTool(); await tool.initialize(); return tool; })();
  return (await runtime).getTool(name)!.execute(args, context);
}

/** Keep these framework tools advertised; BaseTool still enforces permissions and auditing. */
export function buildSkillResourceHandlers(): ToolHandler[] {
  return [
    { name: 'read_skill_resource', description: 'Read a supporting text file or list a directory inside a registered skill bundle. Use relative paths from get_skill; no workspace allowlist change is needed.', parameters: resourceParameters,
      execute: (args, context) => execute('read_resource', args, context) },
    { name: 'run_skill_script', description: 'Run a packaged Node.js/Python script from a skill assigned to your role. Offline, credential-free sandbox; writes only to this session workspace. Requires Linux bubblewrap. Not available in plan mode. Check exitCode and stderr; a nonzero exit is failure.', parameters: scriptParameters,
      execute: (args, context) => execute('run_script', args, context) },
  ];
}

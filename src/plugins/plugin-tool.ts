import { manifestTools } from '@octipus/plugin-sdk';
import type { AgentContext, ToolManifest } from '@/core/types';
import { getVault } from '@/security/vault';
import { BaseTool, createParameterSchema } from '@/tools/base-tool';
import type { LoadedPlugin } from './types';

export class PluginTool extends BaseTool {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  private plugin: LoadedPlugin;

  constructor(plugin: LoadedPlugin) {
    super();
    this.plugin = plugin;
    this.id = `plugin-${plugin.manifest.name}`;
    this.name = plugin.manifest.name;
    this.version = plugin.manifest.version;
    this.description = plugin.manifest.description;
  }

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      author: this.plugin.manifest.author,
      permissions: [
        {
          action: 'execute',
          description: `Execute ${this.name} plugin tools`,
          defaultLevel: 'ASK',
        },
      ],
      tools: manifestTools(this.plugin.manifest).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        returns: 'Plugin tool result',
      })),
    };
  }

  protected async registerTools(): Promise<void> {
    for (const toolDef of manifestTools(this.plugin.manifest)) {
      const handler = this.plugin.module.tools[toolDef.name];
      if (!handler) continue;

      this.registerTool(
        toolDef.name,
        toolDef.description,
        createParameterSchema(toolDef.parameters),
        async (args, context) => {
          try {
            const config = await this.resolveSecrets(context);
            return await handler(args, { config });
          } catch (err: any) {
            return { error: `Plugin tool error: ${err.message}` };
          }
        },
        { permissionAction: 'execute' },
      );
    }
  }

  /**
   * Resolve the plugin's declared secrets from the vault for the CALLING user,
   * at call time. User-scoped secrets win; falls back to system scope. Secrets
   * are never read from `.env` — the vault is the source of truth.
   */
  private async resolveSecrets(
    context: AgentContext,
  ): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = {};
    const secrets = this.plugin.manifest.secrets;
    if (!secrets) return config;

    const vault = getVault();
    for (const [configKey, secretName] of Object.entries(secrets)) {
      const value = await vault.getForAgent(
        { userId: context.userId, toolId: this.id, agentId: context.id },
        secretName,
      );
      if (value !== null) config[configKey] = value;
    }
    return config;
  }

  /**
   * Shutdown the plugin tool and call the plugin's shutdown hook
   */
  override async shutdown(): Promise<void> {
    if (this.plugin.module.shutdown) {
      await this.plugin.module.shutdown();
    }
    await super.shutdown();
  }
}

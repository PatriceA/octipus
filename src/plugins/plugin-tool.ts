import { BaseTool, createParameterSchema } from '@/tools/base-tool';
import type { ToolManifest } from '@/core/types';
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
      tools: this.plugin.manifest.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        returns: 'Plugin tool result',
      })),
    };
  }

  protected async registerTools(): Promise<void> {
    for (const toolDef of this.plugin.manifest.tools) {
      const handler = this.plugin.module.tools[toolDef.name];
      if (!handler) continue;

      this.registerTool(
        toolDef.name,
        toolDef.description,
        createParameterSchema(toolDef.parameters),
        async (args) => {
          try {
            return await handler(args);
          } catch (err: any) {
            return { error: `Plugin tool error: ${err.message}` };
          }
        },
        { permissionAction: 'execute' },
      );
    }
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

import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getLoadedPlugins, getLoadedPlugin, reloadPlugin, PluginTool } from '@/plugins';
import { getToolRegistry } from '@/tools/registry';

export const pluginRoutes = new Elysia({ prefix: '/plugins' })
  .use(apiContext)

  // List all loaded plugins
  .get(
    '/',
    async ({ user }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const plugins = getLoadedPlugins();

      return {
        plugins: plugins.map((p) => ({
          name: p.manifest.name,
          version: p.manifest.version,
          description: p.manifest.description,
          author: p.manifest.author,
          directory: p.directory,
          tools: p.manifest.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        })),
      };
    },
    { detail: { tags: ['plugins'] } },
  )

  // Get a specific plugin's details
  .get(
    '/:name',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const plugin = getLoadedPlugin(params.name);
      if (!plugin) {
        return { error: `Plugin "${params.name}" not found` };
      }

      return {
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        author: plugin.manifest.author,
        main: plugin.manifest.main,
        directory: plugin.directory,
        tools: plugin.manifest.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      };
    },
    {
      params: t.Object({ name: t.String() }),
      detail: { tags: ['plugins'] },
    },
  )

  // Reload a specific plugin (for development)
  .post(
    '/:name/reload',
    async ({ user, params }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      const registry = getToolRegistry();
      const oldToolId = `plugin-${params.name}`;

      try {
        // Unregister the old plugin tool if it exists
        if (registry.has(oldToolId)) {
          await registry.unregister(oldToolId);
        }

        // Reload the plugin from disk
        const plugin = await reloadPlugin(params.name);

        // Re-register as a tool
        const pluginTool = new PluginTool(plugin);
        await registry.register(pluginTool);

        return {
          message: `Plugin "${params.name}" reloaded successfully`,
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          tools: plugin.manifest.tools.length,
        };
      } catch (err) {
        return { error: `Failed to reload plugin: ${(err as Error).message}` };
      }
    },
    {
      params: t.Object({ name: t.String() }),
      detail: { tags: ['plugins'] },
    },
  );

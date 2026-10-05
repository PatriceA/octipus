import { getModelRegistry } from '@/models/model-registry';
import { registerCommand } from './registry';

registerCommand({
  name: 'models',
  description: 'List available models',
  async execute(ctx) {
    try {
      const registry = getModelRegistry();
      // The caller's models: install/org rows they may use plus their own
      // personal rows — never another user's (coworking spec §8.1).
      const models = (await registry.getModelsForUser(ctx.userId)).filter(m => m.isEnabled);

      if (models.length === 0) {
        return { response: 'No models configured. Add models in the Models page.' };
      }

      const rows = models.map(m => {
        const status = m.isEnabled ? 'Active' : 'Disabled';
        const isDefault = m.isDefault ? ' (default)' : '';
        return `| ${m.name}${isDefault} | ${m.provider} | ${m.modelId} | ${status} |`;
      }).join('\n');

      return {
        response: [
          `**Available Models** (${models.length})\n`,
          '| Name | Provider | Model ID | Status |',
          '|------|----------|----------|--------|',
          rows,
        ].join('\n'),
      };
    } catch {
      return { response: 'Failed to load models. Check the backend logs.' };
    }
  },
});

import { registerCommand } from './registry';
import { getModelRegistry } from '@/models/model-registry';

registerCommand({
  name: 'models',
  description: 'List available models',
  async execute() {
    try {
      const registry = getModelRegistry();
      const models = await registry.getAllModels();

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

import { getModelRegistry } from '@/models/model-registry';
import {
  clearSessionModel,
  getSessionModel,
  setSessionModel,
} from '@/core/agent/session-model-override';
import { registerCommand } from './registry';

/**
 * `/model` — manage the per-session root agent model override.
 *
 *   /model                       → show the active override (if any)
 *   /model <modelId|name>        → switch the root agent to that model
 *                                  for the remainder of the session
 *   /model clear                 → drop the override; revert to default
 *   /model list                  → list available models (same as /models)
 *
 * Specialist workers continue to resolve via their topic→model binding;
 * only the root agent honors this override. Persistence is in-memory
 * (reset on restart) — see `session-model-override.ts`.
 */
registerCommand({
  name: 'model',
  description: 'Switch the rootAgent model for this session. Use `/model <id>` to set, `/model clear` to reset, `/model` to show the current override.',
  async execute(ctx) {
    const arg = ctx.args.trim();
    const registry = getModelRegistry();

    if (arg === '' || arg.toLowerCase() === 'show' || arg.toLowerCase() === 'status') {
      const current = getSessionModel(ctx.sessionId);
      if (!current) {
        return { response: 'No session override set. Root agent will use the configured default. Use `/model <id>` to switch.' };
      }
      return { response: `Session model override: \`${current}\`. Use \`/model clear\` to revert.` };
    }

    if (arg.toLowerCase() === 'clear' || arg.toLowerCase() === 'reset') {
      const removed = clearSessionModel(ctx.sessionId);
      return {
        response: removed
          ? 'Session model override cleared. Root agent reverts to the configured default.'
          : 'No session override was active.',
      };
    }

    if (arg.toLowerCase() === 'list') {
      const models = await registry.getAllModels();
      if (models.length === 0) {
        return { response: 'No models configured. Add models in the Models page.' };
      }
      const lines = models.map(m => `- \`${m.modelId}\` (${m.provider})${m.isDefault ? ' — default' : ''}`);
      return { response: ['Available models:', ...lines].join('\n') };
    }

    // Resolve the argument as either modelId (exact) or display name.
    const target = arg;
    const byId = await registry.getModelByModelId(target);
    let resolved = byId ?? null;
    if (!resolved) {
      const all = await registry.getAllModels();
      resolved = all.find(m => m.name.toLowerCase() === target.toLowerCase()) ?? null;
    }
    if (!resolved) {
      return {
        response: `No model named \`${target}\`. Use \`/model list\` to see available models.`,
      };
    }
    if (!resolved.isEnabled) {
      return {
        response: `\`${resolved.modelId}\` is disabled. Enable it in the Models page before switching.`,
      };
    }
    setSessionModel(ctx.sessionId, resolved.modelId);
    return {
      response: `Root agent model switched to \`${resolved.modelId}\` for this session. Use \`/model clear\` to revert.`,
    };
  },
});

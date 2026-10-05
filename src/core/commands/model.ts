import { getModelRegistry } from '@/models/model-registry';
import { resolveModel } from '@/models/resolve-model';
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
 * (reset on restart) — see `session-model-override.ts`. The override is the
 * caller's own (keyed by session and user), and `<id>` resolves only to a
 * model the caller may use (coworking spec §8.2).
 */
registerCommand({
  name: 'model',
  description: 'Switch the rootAgent model for this session. Use `/model <id>` to set, `/model clear` to reset, `/model` to show the current override.',
  async execute(ctx) {
    const arg = ctx.args.trim();
    const registry = getModelRegistry();

    if (arg === '' || arg.toLowerCase() === 'show' || arg.toLowerCase() === 'status') {
      const current = getSessionModel(ctx.sessionId, ctx.userId);
      if (!current) {
        return { response: 'No session override set. Root agent will use the configured default. Use `/model <id>` to switch.' };
      }
      return { response: `Session model override: \`${current}\`. Use \`/model clear\` to revert.` };
    }

    if (arg.toLowerCase() === 'clear' || arg.toLowerCase() === 'reset') {
      const removed = clearSessionModel(ctx.sessionId, ctx.userId);
      return {
        response: removed
          ? 'Session model override cleared. Root agent reverts to the configured default.'
          : 'No session override was active.',
      };
    }

    if (arg.toLowerCase() === 'list') {
      const models = (await registry.getModelsForUser(ctx.userId)).filter(m => m.isEnabled);
      if (models.length === 0) {
        return { response: 'No models configured. Add models in the Models page.' };
      }
      const lines = models.map(m => `- \`${m.modelId}\` (${m.provider})${m.isDefault ? ' — default' : ''}`);
      return { response: ['Available models:', ...lines].join('\n') };
    }

    // Resolve the argument as a row name or modelId the caller may use, then
    // as a case-insensitive display name among the caller's models.
    const target = arg;
    let resolved = await resolveModel({ userId: ctx.userId, name: target });
    if (!resolved) {
      const visible = await registry.getModelsForUser(ctx.userId);
      const match = visible.find(m => m.name.toLowerCase() === target.toLowerCase()) ?? null;
      if (match && !match.isEnabled) {
        return {
          response: `\`${match.modelId}\` is disabled. Enable it in the Models page before switching.`,
        };
      }
      resolved = match;
    }
    if (!resolved) {
      const disabled = await registry.getModelVisibleTo(target, ctx.userId);
      if (disabled && !disabled.isEnabled) {
        return {
          response: `\`${disabled.modelId}\` is disabled. Enable it in the Models page before switching.`,
        };
      }
      return {
        response: `No model named \`${target}\`. Use \`/model list\` to see available models.`,
      };
    }
    setSessionModel(ctx.sessionId, ctx.userId, resolved.name);
    return {
      response: `Root agent model switched to \`${resolved.modelId}\` for this session. Use \`/model clear\` to revert.`,
    };
  },
});

import { togglePlanMode } from '@/core/orchestrator/plan-mode';
import { registerCommand } from './registry';

/**
 * `/plan [on|off]` — explore and propose, change nothing.
 *
 * Registered on the chat path as well as the gateway path because those are two
 * different registries and `handleCommand` runs first: a plan mode reachable
 * only from the TUI is one that silently does nothing over the API.
 */
registerCommand({
  name: 'plan',
  description: 'Toggle plan mode — explore and propose without changing anything (/plan on|off)',
  async execute(ctx) {
    const { text } = await togglePlanMode(ctx.sessionId, ctx.args);
    return { response: text };
  },
});

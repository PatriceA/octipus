import { compactSessionCommand } from '@/core/agent/session-compaction';
import { registerCommand } from './registry';

registerCommand({
  name: 'compact',
  description: 'Summarize older context (/compact [focus instructions])',
  async execute(ctx) {
    return { response: await compactSessionCommand(ctx.sessionId, ctx.args) };
  },
});

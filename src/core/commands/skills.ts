import { handleSkillSelectionCommand } from '@/skills/selection-command';
import { registerCommand } from './registry';

registerCommand({
  name: 'skills',
  description: 'List or select skills: /skills <id or name> always|session|auto [--global]',
  async execute(ctx) {
    return { response: await handleSkillSelectionCommand(ctx.userId, ctx.sessionId, ctx.args) };
  },
});

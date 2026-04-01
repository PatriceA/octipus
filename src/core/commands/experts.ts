import { registerCommand } from './registry';

const iconToEmoji: Record<string, string> = {
  code: '💻', eye: '👀', search: '🔍', palette: '🎨', server: '🔧',
  shield: '🔒', database: '🗃', brain: '🧠', 'check-circle': '✅',
  'trending-up': '📈', workflow: '🔄', clipboard: '📋', 'book-open': '📖',
  mail: '📩', bot: '🤖', 'file-text': '📄', 'bar-chart': '📊',
};

async function handleExpert(ctx: import('./registry').CommandContext): Promise<import('./registry').CommandResult> {
  try {
    const { getDb } = await import('@/db/postgres');
    const { experts } = await import('@/db/schema/experts');
    const { sessionRepository } = await import('@/db/repositories/session-repository');
    const { sql } = await import('drizzle-orm');
    const db = getDb();

    const expertName = ctx.args.trim();

    // No args → list experts
    if (!expertName) {
      const allExperts = await db.select({
        name: experts.name,
        role: experts.role,
        description: experts.description,
        icon: experts.icon,
      }).from(experts);

      if (allExperts.length === 0) {
        return { response: 'No experts configured. Add experts via the web UI or API.' };
      }

      const lines = allExperts.map(e => {
        const emoji = iconToEmoji[e.icon || ''] || '🤖';
        return `  ${emoji} ${e.name} — ${e.description || e.role}`;
      });

      return {
        response: `Available experts:\n${lines.join('\n')}\n\nUse /expert <name> to switch, /expert reset to auto-route.`,
      };
    }

    // Reset → clear expert
    if (expertName.toLowerCase() === 'reset') {
      const session = await sessionRepository.findById(ctx.sessionId);
      const sessionCtx = (session?.context as Record<string, unknown>) || {};
      delete sessionCtx.activeExpertId;
      delete sessionCtx.activeExpertName;
      await sessionRepository.update(ctx.sessionId, { context: sessionCtx });
      return { response: 'Expert reset to auto-routing. Next messages will be classified automatically.' };
    }

    // Switch to expert
    const [match] = await db.select({ id: experts.id, name: experts.name })
      .from(experts)
      .where(sql`LOWER(${experts.name}) = LOWER(${expertName})`)
      .limit(1);

    if (!match) {
      return { response: `Expert "${expertName}" not found. Use /expert to list available experts.` };
    }

    // Store active expert in session context (persists across reconnects)
    const session = await sessionRepository.findById(ctx.sessionId);
    const sessionCtx = (session?.context as Record<string, unknown>) || {};
    sessionCtx.activeExpertId = match.id;
    sessionCtx.activeExpertName = match.name;
    await sessionRepository.update(ctx.sessionId, { context: sessionCtx });

    return { response: `Switched to expert: ${match.name}. Next messages will be handled by this expert.` };
  } catch {
    return { response: 'Failed to load experts. Check the backend logs.' };
  }
}

// Register both /expert and /experts
registerCommand({
  name: 'expert',
  description: 'Switch expert or list available experts',
  execute: handleExpert,
});

registerCommand({
  name: 'experts',
  description: 'Switch expert or list available experts',
  execute: handleExpert,
});

import { registerCommand } from './registry';

const iconToEmoji: Record<string, string> = {
  'file-text': '\u25A0',  // Summarizer — ■
  'bar-chart': '\u25B2',  // Data Analyst — ▲
  search: '\u25C6',       // Researcher — ◆
  shield: '\u25C8',       // Security — ◈
  'book-open': '\u25B6',  // Technical Writer — ▶
  bot: '\u25CF',          // General — ●
  server: '\u25A1',       // DevOps — □
  database: '\u25A3',     // Data Engineer — ▣
  brain: '\u2605',        // AI Engineer — ★
  'check-circle': '\u2713', // QA Engineer — ✓
  'trending-up': '\u25B3', // Financial — △
  code: '\u2302',         // Coder — ⌂
  mail: '\u2709',         // Communicator — ✉
  eye: '\u25CE',          // Reviewer — ◎
  palette: '\u2740',      // UI/UX Designer — ❀
  workflow: '\u21BB',      // Automation — ↻
  clipboard: '\u2630',    // PM — ☰
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

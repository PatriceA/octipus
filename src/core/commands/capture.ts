import { getNoteService } from '@/core/knowledge/notes';
import { registerCommand } from './registry';

/**
 * Knowledge-graph Tier 2 — quick capture to today's daily note.
 * `/capture <text>` appends a timestamped line; [[wikilinks]] and #tags
 * in the text are wired into the knowledge graph immediately. Goes
 * through the gateway like every other command — no per-channel code.
 */
registerCommand({
  name: 'capture',
  description: 'Capture a quick note to today\'s daily note (/capture <text>)',
  async execute(ctx) {
    const text = ctx.args.trim();
    if (!text) {
      return { response: 'Usage: `/capture <text>` — appends a timestamped line to today\'s daily note.' };
    }
    const note = await getNoteService().capture(ctx.userId, null, text);
    return { response: `Captured to **${note.slug}**.` };
  },
});

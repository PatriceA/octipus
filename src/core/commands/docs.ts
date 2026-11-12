import { productDocs } from '@/core/product-docs';
import { coreLogger } from '@/utils/logger';
import { registerCommand } from './registry';

/** Direct, local manual lookup. No chat model, embedding provider or knowledge DB. */
registerCommand({
  name: 'docs',
  description: 'Search the bundled Octipus documentation locally (no model required)',
  async execute(ctx) {
    const query = ctx.args.trim();
    if (!query) return { response: 'Usage: `/docs <keywords>` — e.g. `/docs Telegram setup` or `/docs model provider`.' };
    try {
      const hits = await productDocs.search(query, 8);
      if (!hits.length) return { response: `No bundled product documentation matches "${query}". Try specific feature or setting names.` };
      return { response: `**Product documentation — "${query}":**\n\n` + hits.map((hit, i) =>
        `${i + 1}. **${hit.heading}** — docs/${hit.file}:${hit.line}\n${hit.excerpt.slice(0, 500)}`).join('\n\n') };
    } catch (err) {
      coreLogger.warn({ err }, '/docs local manual search failed');
      return { response: 'The bundled Octipus manual is unavailable. Check that this installation includes the docs directory; no embedding model is needed.' };
    }
  },
});

import { basename } from 'path';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { coreLogger } from '@/utils/logger';
import { registerCommand } from './registry';

/**
 * `/docs <query>` — search Octipus's own product documentation (indexed into
 * the knowledge base by `src/db/seed-docs.ts`) and return the top matching
 * sections directly. No LLM call: this is a deterministic lookup over the
 * GLOBAL `document` rows tagged `source = 'octipus-docs'`, so it works even
 * when no chat model is configured.
 */

const RESULT_LIMIT = 8;

registerCommand({
  name: 'docs',
  description: 'Search the product documentation (setup, channels, providers, configuration)',
  async execute(ctx) {
    const query = ctx.args.trim();
    if (!query) {
      return {
        response: 'Usage: `/docs <query>` — e.g. `/docs how do I set up Telegram` or `/docs add a model provider`.',
      };
    }

    try {
      const service = getEmbeddingService();
      // Hard-scoped in SQL to the GLOBAL product-docs corpus
      // (`user_id IS NULL AND metadata->>'source' = 'octipus-docs'`). This app
      // is always multi-user, so an unscoped `document` search would also match
      // every other tenant's private uploads — leaking them as a ranking signal
      // and letting a tenant with many private docs crowd the docs chunks out
      // of the fetch window. Scoping in SQL means no over-fetch + post-filter.
      const docHits = await service.searchGlobalDocs(query, RESULT_LIMIT);

      if (docHits.length === 0) {
        return {
          response: `No product documentation matches "${query}". The docs may not cover this yet, or the knowledge base has not finished indexing them. Try rephrasing, or ask in plain language and the assistant will look it up.`,
        };
      }

      const lines = docHits.map((h, i) => {
        const file = h.metadata.filePath ? basename(h.metadata.filePath) : h.sourceId;
        const section = h.sectionPath && h.sectionPath.length > 0 ? h.sectionPath.join(' › ') : null;
        const heading = section ? `**${section}**` : `**${file}**`;
        const snippet = (h.abstract || h.content || '').trim().replace(/\s+/g, ' ').slice(0, 240);
        const src = section ? `  \n_${file}_` : '';
        return `${i + 1}. ${heading}\n${snippet}${src}`;
      });

      return {
        response: [
          `**Product docs — top ${docHits.length} for "${query}":**`,
          '',
          lines.join('\n\n'),
        ].join('\n'),
      };
    } catch (err) {
      coreLogger.warn({ err, query }, '/docs search failed — knowledge base may not be ready');
      return { response: 'Documentation search is unavailable right now (the knowledge base may not be ready). Check the backend logs.' };
    }
  },
});

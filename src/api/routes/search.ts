import { ilike, or, } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getDb } from '@/db/postgres';
import { hooks } from '@/db/schema/hooks';
import { modelConfig } from '@/db/schema/models';
import { sessions } from '@/db/schema/sessions';
import { skills } from '@/db/schema/skills';
import { getToolRegistry } from '@/tools/registry';

interface SearchResult {
  id: string;
  type: 'session' | 'hook' | 'model' | 'skill' | 'knowledge' | 'tool';
  title: string;
  subtitle: string;
  href: string;
}

export const searchRoutes = new Elysia({ prefix: '/search' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, query: { q, limit: limitStr } }) => {
      if (!user) {
        return { error: 'Not authenticated' };
      }

      if (!q || q.trim().length < 2) {
        return { results: [] };
      }

      const searchTerm = q.trim();
      const limit = limitStr ? parseInt(limitStr, 10) : 10;
      const pattern = `%${searchTerm}%`;
      const db = getDb();

      const results: SearchResult[] = [];

      // Run all searches in parallel
      const [
        sessionResults,
        hookResults,
        modelResults,
        skillResults,
        knowledgeResults,
        toolResults,
      ] = await Promise.allSettled([
        // Sessions — search by title
        db
          .select({ id: sessions.id, title: sessions.title, channelType: sessions.channelType, status: sessions.status })
          .from(sessions)
          .where(ilike(sessions.title, pattern))
          .limit(limit),

        // Hooks — search by name or description
        db
          .select({ id: hooks.id, name: hooks.name, description: hooks.description, trigger: hooks.trigger })
          .from(hooks)
          .where(or(ilike(hooks.name, pattern), ilike(hooks.description, pattern)))
          .limit(limit),

        // Models — search by name
        db
          .select({ id: modelConfig.id, name: modelConfig.name, provider: modelConfig.provider, modelId: modelConfig.modelId })
          .from(modelConfig)
          .where(ilike(modelConfig.name, pattern))
          .limit(limit),

        // Skills — search by name or description
        db
          .select({ id: skills.id, name: skills.name, description: skills.description, category: skills.category })
          .from(skills)
          .where(or(ilike(skills.name, pattern), ilike(skills.description, pattern)))
          .limit(limit),

        // Knowledge — full-text search
        (async () => {
          try {
            const service = getEmbeddingService();
            return await service.ftsSearch(searchTerm, limit);
          } catch {
            return [];
          }
        })(),

        // Tools — in-memory search
        (async () => {
          const registry = getToolRegistry();
          const allTools = registry.getAll();
          const lower = searchTerm.toLowerCase();
          return allTools.filter(
            (tool) =>
              tool.name.toLowerCase().includes(lower) ||
              tool.id.toLowerCase().includes(lower) ||
              tool.description.toLowerCase().includes(lower)
          );
        })(),
      ]);

      // Map session results
      if (sessionResults.status === 'fulfilled') {
        for (const s of sessionResults.value) {
          results.push({
            id: s.id,
            type: 'session',
            title: s.title || 'Untitled session',
            subtitle: `${s.channelType} - ${s.status}`,
            href: `/chat?session=${s.id}`,
          });
        }
      }

      // Map hook results
      if (hookResults.status === 'fulfilled') {
        for (const h of hookResults.value) {
          results.push({
            id: h.id,
            type: 'hook',
            title: h.name,
            subtitle: h.description || `Trigger: ${h.trigger}`,
            href: `/hooks?hook=${h.id}`,
          });
        }
      }

      // Map model results
      if (modelResults.status === 'fulfilled') {
        for (const m of modelResults.value) {
          results.push({
            id: m.id,
            type: 'model',
            title: m.name,
            subtitle: `${m.provider} - ${m.modelId}`,
            href: `/models`,
          });
        }
      }

      // Map skill results
      if (skillResults.status === 'fulfilled') {
        for (const s of skillResults.value) {
          results.push({
            id: s.id,
            type: 'skill',
            title: s.name,
            subtitle: s.description?.slice(0, 80) || s.category,
            href: `/skills`,
          });
        }
      }

      // Map knowledge results
      if (knowledgeResults.status === 'fulfilled') {
        for (const k of knowledgeResults.value) {
          results.push({
            id: k.id,
            type: 'knowledge',
            title: k.abstract || k.sourceId || 'Knowledge entry',
            subtitle: `${k.purpose}${k.similarity ? ` - relevance: ${(k.similarity * 100).toFixed(0)}%` : ''}`,
            href: `/knowledge`,
          });
        }
      }

      // Map tool results
      if (toolResults.status === 'fulfilled') {
        for (const tool of toolResults.value) {
          results.push({
            id: tool.id,
            type: 'tool',
            title: tool.name,
            subtitle: tool.description,
            href: `/tools`,
          });
        }
      }

      return { results: results.slice(0, limit * 3) };
    },
    {
      query: t.Object({
        q: t.String(),
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['search'] },
    }
  );

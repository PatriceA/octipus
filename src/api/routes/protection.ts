import { apiContext } from '@/api/context';
import { Elysia, t } from '@/api/http';
import { isProtectedEntity, PROTECTED_ENTITIES, ProtectionLevelError, setProtectionLevel } from '@/core/protection/levels';
import { contentRepos } from '@/db/repositories/content';
import { isAuthenticated } from '@/security/principal';
import { SpaceError } from '@/security/space-access';

/**
 * Protection levels (docs/PROTECTION-LEVELS.md): a person sets the level of a
 * document, case, record or mail message, through the caller's content scope
 * (in a space: editors). A person may lower a level or clear it to unclear;
 * agents only raise (their tool goes through the same function).
 */
export const protectionRoutes = new Elysia({ prefix: '/protection' })
  .use(apiContext)

  .put('/:entity/:id', async ({ principal, params, body, set }) => {
    if (!isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    if (!isProtectedEntity(params.entity)) { set.status = 404; return { error: `Unknown kind: ${params.entity}` }; }
    try {
      const change = await setProtectionLevel(contentRepos(principal), params.entity, params.id, body.level, 'person');
      if (!change) { set.status = 404; return { error: 'Not found' }; }
      return change;
    } catch (err) {
      if (err instanceof SpaceError) throw err;
      if (err instanceof ProtectionLevelError) { set.status = 400; return { error: err.message }; }
      throw err;
    }
  }, {
    params: t.Object({ entity: t.Union(PROTECTED_ENTITIES.map((e) => t.Literal(e))), id: t.String({ maxLength: 64 }) }),
    body: t.Object({ level: t.Union([t.Integer({ minimum: 1, maximum: 4 }), t.Null()]) }),
    detail: { tags: ['protection'] },
  });

import { Elysia, t } from '@/api/http';
import { adminDenied } from '@/api/admin-guard';
import { apiContext } from '@/api/context';

/**
 * The optional local embedding engine (docs/RAG.md → Local embeddings).
 * Admin-only: it downloads a binary and a model onto this host.
 *
 * - GET    /local-engine          what is installed, what runs, the models offered, the install job
 * - POST   /local-engine/install  { model?, gpu?: 'cpu'|'vulkan' } start (or join) the install; poll GET for progress
 * - DELETE /local-engine          stop it and remove its files (a bound row is unbound and removed)
 */
export const localEngineRoutes = new Elysia({ prefix: '/local-engine' })
  .use(apiContext)
  .get('/', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    const { LOCAL_ENGINE_MANIFEST, platformKey } = await import('@/capabilities/local-engine/manifest');
    const { isModelInstalled, localEngineStatus, engineBinaryPath } = await import('@/capabilities/local-engine/engine-process');
    const { localEngineJob, rowName } = await import('@/capabilities/local-engine/install');
    const { activeEngine } = await import('@/capabilities/local-engine/paths');
    const { getModelRegistry } = await import('@/models/model-registry');
    const embedding = await getModelRegistry().getModelForTopic('embedding');
    const { existsSync } = await import('node:fs');
    const bin = engineBinaryPath();
    return {
      platform: platformKey(),
      engine: {
        tag: LOCAL_ENGINE_MANIFEST.engine.tag, installed: !!bin && existsSync(bin), active: activeEngine(),
        gpu: Object.keys(LOCAL_ENGINE_MANIFEST.engine.gpu?.vulkan ?? {}).includes(platformKey() ?? '') ? ['vulkan'] : [],
      },
      models: LOCAL_ENGINE_MANIFEST.models.map((m) => ({
        id: m.id, label: m.label, sizeBytes: m.size, dims: m.dims, license: m.license,
        default: m.id === LOCAL_ENGINE_MANIFEST.defaultModel,
        installed: isModelInstalled(m),
        bound: embedding?.name === rowName(m),
      })),
      embeddingBound: embedding ? embedding.name : null,
      process: localEngineStatus(),
      job: localEngineJob(),
    };
  }, { detail: { tags: ['local-engine'] } })
  .post('/install', async ({ user, principal, body, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    const { startLocalEngineInstall } = await import('@/capabilities/local-engine/install');
    try {
      const job = startLocalEngineInstall(user!.id, body?.model, undefined, body?.gpu ? { gpu: body.gpu } : {});
      set.status = 202;
      return { job };
    } catch (err) {
      set.status = 400;
      return { error: (err as Error).message };
    }
  }, {
    body: t.Optional(t.Object({ model: t.Optional(t.String({ maxLength: 64 })), gpu: t.Optional(t.Union([t.Literal('cpu'), t.Literal('vulkan')])) })),
    detail: { tags: ['local-engine'] },
  })
  .delete('/', async ({ user, principal, set }) => {
    const denied = adminDenied({ set, user, principal });
    if (denied) return denied;
    const { removeLocalEngine } = await import('@/capabilities/local-engine/install');
    return { ok: true, ...(await removeLocalEngine()) };
  }, { detail: { tags: ['local-engine'] } });

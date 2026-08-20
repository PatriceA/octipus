import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { handlePersonaCommand } from '@/core/personas/commands';
import { getPersonaProfileRepository, PersonaProfileRepository } from '@/core/personas/repository';
import { getPersonaRegistry } from '@/core/personas/registry';
import { resolvePersonaForUser } from '@/core/personas/resolver';

/**
 * Persona settings API. Backs the `/persona` page in the web UI and
 * any future remote-config clients. Per-user only — no admin path.
 *
 *   GET    /persona              — resolved persona for the current user
 *   GET    /persona/presets      — list all shipped preset YAMLs
 *   PATCH  /persona              — update name / tone / narration / preset_id
 *   POST   /persona/facts        — append a free-form user fact
 *   DELETE /persona/facts/:idx   — remove a free-form fact by index
 *   POST   /persona/reset        — restore base Octipus
 *   GET    /persona/arms         — per-arm persona bindings
 *   PUT    /persona/arms/:role   — shadow one arm's voice with a preset
 *   DELETE /persona/arms/:role   — clear it (the arm runs with no persona)
 */
export const personaRoutes = new Elysia({ prefix: '/persona' })
  .use(apiContext)

  .get(
    '/',
    async ({ user, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const persona = await resolvePersonaForUser(user.id);
      return {
        id: persona.id,
        presetId: persona.presetId,
        name: persona.name,
        pronouns: persona.pronouns,
        tone: persona.tone,
        narration: persona.narration,
        signaturePhrases: persona.signaturePhrases,
        userFacts: persona.userFacts,
      };
    },
    { detail: { tags: ['persona'] } },
  )

  .get(
    '/presets',
    async () => {
      await getPersonaRegistry().ensureLoaded();
      const presets = getPersonaRegistry().list();
      return {
        presets: presets.map(p => ({
          id: p.id,
          displayName: p.display_name,
          name: p.name,
          pronouns: p.pronouns,
          tone: p.tone,
          isDefault: p.is_default,
          narration: p.defaults.narration,
          signaturePhrases: p.signature_phrases,
        })),
      };
    },
    { detail: { tags: ['persona'] } },
  )

  .patch(
    '/',
    async ({ user, body, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const { name, tone, narration, presetId } = body as {
        name?: string;
        tone?: string;
        narration?: string;
        presetId?: string;
      };
      const results: string[] = [];
      if (typeof presetId === 'string' && presetId.length > 0) {
        const r = await handlePersonaCommand({ userId: user.id, rawArgs: `use ${presetId}` });
        results.push(r.text);
      }
      if (typeof name === 'string' && name.length > 0) {
        const r = await handlePersonaCommand({ userId: user.id, rawArgs: `name ${name}` });
        results.push(r.text);
      }
      if (typeof tone === 'string' && tone.length > 0) {
        const r = await handlePersonaCommand({ userId: user.id, rawArgs: `tone ${tone}` });
        results.push(r.text);
      }
      if (typeof narration === 'string' && narration.length > 0) {
        const r = await handlePersonaCommand({ userId: user.id, rawArgs: `narration ${narration}` });
        results.push(r.text);
      }
      if (results.length === 0) {
        set.status = 400;
        return { error: 'no fields to update' };
      }
      const persona = await resolvePersonaForUser(user.id);
      return { messages: results, persona };
    },
    {
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 40 })),
        tone: t.Optional(t.String()),
        narration: t.Optional(t.String()),
        presetId: t.Optional(t.String()),
      }),
      detail: { tags: ['persona'] },
    },
  )

  .post(
    '/facts',
    async ({ user, body, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const { fact } = body as { fact: string };
      const r = await handlePersonaCommand({ userId: user.id, rawArgs: `say ${fact}` });
      if (r.text.includes('longer fact') || r.text.includes('too long')) {
        set.status = 400;
        return { error: r.text };
      }
      const persona = await resolvePersonaForUser(user.id);
      return { message: r.text, persona };
    },
    {
      body: t.Object({ fact: t.String({ minLength: 4, maxLength: 280 }) }),
      detail: { tags: ['persona'] },
    },
  )

  .delete(
    '/facts/:idx',
    async ({ user, params, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const idx = Number(params.idx);
      if (!Number.isFinite(idx) || idx < 0) {
        set.status = 400;
        return { error: 'invalid index' };
      }
      const repo = getPersonaProfileRepository();
      const profile = await repo.findForUser(user.id);
      if (!profile) {
        set.status = 404;
        return { error: 'no persona profile' };
      }
      const facts = (profile.facts as Array<{ key: string; value: string }>) || [];
      const target = facts.filter(f => f.key.startsWith('extra:'))[idx];
      if (!target) {
        set.status = 404;
        return { error: 'fact not found' };
      }
      const remaining = facts.filter(f => f.key !== target.key);
      const { getDb } = await import('@/db/postgres');
      const { profiles } = await import('@/db/schema/profiles');
      const { eq } = await import('drizzle-orm');
      await getDb()
        .update(profiles)
        .set({ facts: remaining, updatedAt: new Date() })
        .where(eq(profiles.id, profile.id));
      const persona = await resolvePersonaForUser(user.id);
      return { persona };
    },
    { detail: { tags: ['persona'] } },
  )

  // ── Per-arm persona shadowing (wave 4) ────────────────────────────
  // An arm with no binding carries NO persona, which is what every arm did
  // before this existed — so the empty map is the normal, correct answer here.
  .get(
    '/arms',
    async ({ user, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const profile = await getPersonaProfileRepository().findForUser(user.id);
      const arms = profile ? PersonaProfileRepository.toFields(profile).armPresets : {};
      return { arms };
    },
    { detail: { tags: ['persona'] } },
  )

  .put(
    '/arms/:role',
    async ({ user, params, body, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const r = await handlePersonaCommand({
        userId: user.id,
        rawArgs: `arm ${params.role} ${body.presetId}`,
      });
      // The command layer owns validation (unknown role, unknown preset, and
      // the orchestrator's "use the host persona instead"). Rather than a
      // second copy of those rules, treat a refusal as a 400 — the message is
      // already the explanation.
      const profile = await getPersonaProfileRepository().findForUser(user.id);
      const arms = profile ? PersonaProfileRepository.toFields(profile).armPresets : {};
      if (arms[params.role] !== body.presetId) {
        set.status = 400;
        return { error: r.text };
      }
      return { message: r.text, arms };
    },
    {
      body: t.Object({ presetId: t.String({ minLength: 1 }) }),
      detail: { tags: ['persona'] },
    },
  )

  .delete(
    '/arms/:role',
    async ({ user, params, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const r = await handlePersonaCommand({ userId: user.id, rawArgs: `arm ${params.role} off` });
      const profile = await getPersonaProfileRepository().findForUser(user.id);
      const arms = profile ? PersonaProfileRepository.toFields(profile).armPresets : {};
      return { message: r.text, arms };
    },
    { detail: { tags: ['persona'] } },
  )

  .post(
    '/reset',
    async ({ user, set }) => {
      if (!user || user.id === 'system') {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      const r = await handlePersonaCommand({ userId: user.id, rawArgs: 'reset' });
      const persona = await resolvePersonaForUser(user.id);
      return { message: r.text, persona };
    },
    { detail: { tags: ['persona'] } },
  );

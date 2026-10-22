import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { readOnboardingState, readProgress, writeProgress, writeStandingInstructions } from '@/core/onboarding/state';
import { storableAnswers, USE_CASES } from '@/shared/onboarding/use-cases';
import type { Answers, UseCaseId } from '@/shared/onboarding/types';
import { isAuthenticated } from '@/security/principal';
import { apiLogger } from '@/utils/logger';

const USE_CASE_IDS = USE_CASES.map((u) => u.id);

/**
 * The onboarding guide (docs/ONBOARDING.md). The guide itself runs in the
 * browser and sets things up through the ordinary routes; these give it what
 * it cannot get elsewhere: one read of what is already set up, the caller's
 * saved progress, and the standing-instructions note at user level.
 */
export const onboardingRoutes = new Elysia({ prefix: '/onboarding' })
  .use(apiContext)

  .get('/', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return readOnboardingState(user.id, Boolean(user.isAdmin));
  }, { detail: { tags: ['onboarding'] } })

  // Just the saved progress: one row read, for the home page to decide
  // whether to show the guide before it asks for the full state.
  .get('/progress', async ({ user, principal, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    return readProgress(user.id);
  }, { detail: { tags: ['onboarding'] } })

  .put('/progress', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    const useCases = (body.useCases as string[] | undefined)?.filter((u): u is UseCaseId => (USE_CASE_IDS as string[]).includes(u));
    // Secrets never land in preferences, whatever the client sends.
    const answers = body.answers ? storableAnswers(body.answers as Answers) : undefined;
    if (answers && JSON.stringify(answers).length > 50_000) { set.status = 413; return { error: 'Answers are too large' }; }
    return writeProgress(user.id, {
      ...(body.dismissed !== undefined ? { dismissed: body.dismissed } : {}),
      ...(useCases ? { useCases } : {}),
      ...(answers ? { answers } : {}),
      ...(body.completed ? { completedAt: new Date().toISOString() } : {}),
    });
  }, {
    body: t.Object({
      dismissed: t.Optional(t.Boolean()),
      useCases: t.Optional(t.Array(t.String({ maxLength: 40 }), { maxItems: 10 })),
      answers: t.Optional(t.Record(t.String({ maxLength: 80 }), t.Unknown())),
      completed: t.Optional(t.Boolean()),
    }),
    detail: { tags: ['onboarding'] },
  })

  .put('/standing-instructions', async ({ user, principal, body, set }) => {
    if (!user || !isAuthenticated(principal)) { set.status = 401; return { error: 'Not authenticated' }; }
    try {
      return await writeStandingInstructions(user.id, body.body);
    } catch (err) {
      apiLogger.error({ err, userId: user.id }, 'onboarding: standing instructions could not be written');
      set.status = 500;
      return { error: 'Could not write the standing instructions' };
    }
  }, {
    body: t.Object({ body: t.String({ minLength: 1, maxLength: 20_000 }) }),
    detail: { tags: ['onboarding'] },
  });

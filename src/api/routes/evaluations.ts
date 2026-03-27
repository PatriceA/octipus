import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getModelRegistry } from '@/models/model-registry';
import { getProviderRouter } from '@/models/providers';
import { getLiteLLMClient } from '@/models/litellm-client';
import {
  runConformanceTests,
  getTestCaseNames,
} from '@/models/testing';
import {
  runEvaluation,
  ALL_EVALUATORS,
  STANDARD_DATASETS,
} from '@/models/evaluation';
import { evaluationRepository } from '@/db/repositories/evaluation-repository';

export const evaluationRoutes = new Elysia({ prefix: '/evaluations' })
  .use(apiContext)

  // ── POST /evaluations/conformance/run ──────────────────────────
  .post(
    '/conformance/run',
    async ({ user, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const { models: modelNames, tests, timeout } = body;

      try {
        const registry = getModelRegistry();
        const router = getProviderRouter();
        const client = getLiteLLMClient();

        // Resolve which models to test (getAllModels returns only enabled models)
        let modelsToTest = await registry.getAllModels();
        if (modelNames && modelNames.length > 0) {
          modelsToTest = modelsToTest.filter((m) =>
            modelNames.includes(m.name) || modelNames.includes(m.modelId) || modelNames.includes(m.id)
          );
        }

        if (modelsToTest.length === 0) {
          set.status = 400;
          return { error: 'No enabled models found to test' };
        }

        // Build provider map: provider name -> ModelProvider instance
        const allProviders = router.getAllProviders();
        const providerMap = new Map(allProviders.map((p) => [p.name, p]));

        // Run conformance tests
        const report = await runConformanceTests(client, modelsToTest, providerMap, {
          tests,
          timeout,
        });

        // Persist results
        const saved = await evaluationRepository.saveConformanceRun(user.id, report);

        return {
          id: saved.id,
          timestamp: report.timestamp,
          models: saved.models,
          summary: report.summary,
          results: report.results,
        };
      } catch (err) {
        set.status = 500;
        return { error: (err as Error).message };
      }
    },
    {
      body: t.Object({
        models: t.Optional(t.Array(t.String())),
        tests: t.Optional(t.Array(t.String())),
        timeout: t.Optional(t.Number()),
      }),
      detail: { tags: ['evaluations'] },
    }
  )

  // ── GET /evaluations/conformance/runs ─────────────────────────
  .get(
    '/conformance/runs',
    async ({ user, set, query }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const limit = query.limit ? parseInt(query.limit, 10) : 20;
      const runs = await evaluationRepository.getConformanceRuns(user.id, limit);

      return {
        runs: runs.map((r) => ({
          id: r.id,
          models: r.models,
          summary: r.summary,
          results: r.results,
          createdAt: r.createdAt,
        })),
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['evaluations'] },
    }
  )

  // ── GET /evaluations/conformance/runs/:id ─────────────────────
  .get(
    '/conformance/runs/:id',
    async ({ user, set, params }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const run = await evaluationRepository.getConformanceRun(params.id);
      if (!run) {
        set.status = 404;
        return { error: 'Conformance run not found' };
      }

      // Users may only access their own runs (unless admin)
      if (run.userId !== user.id && !user.isAdmin) {
        set.status = 403;
        return { error: 'Access denied' };
      }

      return run;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['evaluations'] },
    }
  )

  // ── POST /evaluations/eval/run ────────────────────────────────
  .post(
    '/eval/run',
    async ({ user, body, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const { model, dataset: datasetName, evaluators: evaluatorNames, name } = body;

      try {
        // Resolve dataset
        const datasetKey = datasetName ?? 'generalQA';
        const dataset = STANDARD_DATASETS[datasetKey];
        if (!dataset) {
          set.status = 400;
          return {
            error: `Unknown dataset "${datasetKey}". Available: ${Object.keys(STANDARD_DATASETS).join(', ')}`,
          };
        }

        // Resolve evaluators
        let evaluators = ALL_EVALUATORS;
        if (evaluatorNames && evaluatorNames.length > 0) {
          evaluators = ALL_EVALUATORS.filter((e) => evaluatorNames.includes(e.name));
          if (evaluators.length === 0) {
            set.status = 400;
            return {
              error: `No matching evaluators. Available: ${ALL_EVALUATORS.map((e) => e.name).join(', ')}`,
            };
          }
        }

        // Stamp the dataset with the requested model/provider
        const registry = getModelRegistry();
        const modelConfig = await registry.getModel(model)
          ?? await registry.getModelByModelId(model);
        const provider = modelConfig?.provider ?? 'unknown';
        const modelId = modelConfig?.modelId ?? model;

        // Generate model outputs for data points that don't have one
        const router = (await import('@/models/providers')).getProviderRouter();
        const stampedDataset = [];
        for (const dp of dataset) {
          let output = dp.output;
          if (!output) {
            try {
              const messages: import('@/core/types').AgentMessage[] = [];
              if (dp.systemPrompt) {
                messages.push({ role: 'system', content: dp.systemPrompt, timestamp: new Date() });
              }
              messages.push({ role: 'user', content: dp.input, timestamp: new Date() });
              const completion = await router.complete({
                model: modelId,
                messages,
                temperature: 0.3,
                maxTokens: 1024,
                extraBody: modelConfig?.metadata?.extraBody ?? {},
              });
              output = completion.content;
            } catch (err) {
              output = `[Error generating output: ${err instanceof Error ? err.message : String(err)}]`;
            }
          }
          stampedDataset.push({ ...dp, output, model, provider });
        }

        // Run evaluation
        const run = await runEvaluation(stampedDataset, evaluators, { name });

        // Persist
        const saved = await evaluationRepository.saveEvalRunWithDataset(
          user.id,
          run,
          datasetKey
        );

        return {
          id: saved.id,
          name: saved.name,
          model: saved.model,
          datasetName: saved.datasetName,
          evaluators: saved.evaluators,
          summary: saved.summary,
          createdAt: saved.createdAt,
          results: run.results,
        };
      } catch (err) {
        set.status = 500;
        return { error: (err as Error).message };
      }
    },
    {
      body: t.Object({
        model: t.String(),
        dataset: t.Optional(t.String()),
        evaluators: t.Optional(t.Array(t.String())),
        name: t.Optional(t.String()),
      }),
      detail: { tags: ['evaluations'] },
    }
  )

  // ── GET /evaluations/eval/runs ────────────────────────────────
  .get(
    '/eval/runs',
    async ({ user, set, query }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const limit = query.limit ? parseInt(query.limit, 10) : 20;
      const runs = await evaluationRepository.getEvalRuns(user.id, limit);

      return {
        runs: runs.map((r) => ({
          id: r.id,
          name: r.name,
          model: r.model,
          dataset: r.datasetName,
          evaluators: r.evaluators,
          scores: r.summary,
          results: r.results,
          createdAt: r.createdAt,
        })),
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
      }),
      detail: { tags: ['evaluations'] },
    }
  )

  // ── GET /evaluations/eval/runs/:id ────────────────────────────
  .get(
    '/eval/runs/:id',
    async ({ user, set, params }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const run = await evaluationRepository.getEvalRun(params.id);
      if (!run) {
        set.status = 404;
        return { error: 'Eval run not found' };
      }

      if (run.userId !== user.id && !user.isAdmin) {
        set.status = 403;
        return { error: 'Access denied' };
      }

      return run;
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: { tags: ['evaluations'] },
    }
  )

  // ── GET /evaluations/eval/datasets ───────────────────────────
  .get(
    '/eval/datasets',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      return {
        datasets: Object.entries(STANDARD_DATASETS).map(([name, items]) => ({
          name,
          count: items.length,
        })),
      };
    },
    { detail: { tags: ['evaluations'] } }
  )

  // ── GET /evaluations/eval/evaluators ─────────────────────────
  .get(
    '/eval/evaluators',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      return {
        evaluators: ALL_EVALUATORS.map((e) => ({
          name: e.name,
          description: e.description,
        })),
      };
    },
    { detail: { tags: ['evaluations'] } }
  )

  // ── GET /evaluations/eval/summary ────────────────────────────
  .get(
    '/eval/summary',
    async ({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: 'Not authenticated' };
      }

      const summary = await evaluationRepository.getEvalSummary(user.id);

      return { summary };
    },
    { detail: { tags: ['evaluations'] } }
  );

import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getModelRegistry } from '@/models/model-registry';
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
import { apiLogger } from '@/utils/logger';
import type { AgentMessage } from '@/core/types';

// ── Background job tracker ─────────────────────────────────────
interface RunningJob {
  type: 'conformance' | 'eval';
  userId: string;
  startedAt: Date;
  model?: string;
  dataset?: string;
  status: 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

const activeJobs = new Map<string, RunningJob>();

function generateJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const evaluationRoutes = new Elysia({ prefix: '/evaluations' })
  .use(apiContext)

  // ── GET /evaluations/status — check if any jobs are running ──
  .get(
    '/status',
    async ({ user, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }

      const userJobs: Array<{ id: string } & RunningJob> = [];
      for (const [id, job] of activeJobs) {
        if (job.userId === user.id) userJobs.push({ id, ...job });
      }

      // Clean up completed jobs older than 5 minutes
      const now = Date.now();
      for (const [id, job] of activeJobs) {
        if (job.status !== 'running' && now - job.startedAt.getTime() > 300_000) {
          activeJobs.delete(id);
        }
      }

      const running = userJobs.find(j => j.status === 'running');
      const lastCompleted = userJobs
        .filter(j => j.status !== 'running')
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];

      return {
        running: !!running,
        job: running ?? lastCompleted ?? null,
      };
    },
    { detail: { tags: ['evaluations'] } }
  )

  // ── POST /evaluations/conformance/run ──────────────────────────
  .post(
    '/conformance/run',
    async ({ user, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }

      // Check for already running job
      for (const job of activeJobs.values()) {
        if (job.userId === user.id && job.status === 'running') {
          set.status = 409;
          return { error: 'An evaluation is already running', type: job.type };
        }
      }

      const { models: modelNames, tests, timeout } = body;
      const registry = getModelRegistry();
      const client = getLiteLLMClient();

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

      const jobId = generateJobId();
      const job: RunningJob = {
        type: 'conformance',
        userId: user.id,
        startedAt: new Date(),
        status: 'running',
      };
      activeJobs.set(jobId, job);

      // Run in background — don't await
      (async () => {
        try {
          const { getProviderRouter } = await import('@/models/providers');
          const router = getProviderRouter();
          const allProviders = router.getAllProviders();
          const providerMap = new Map(allProviders.map((p) => [p.name, p]));

          const report = await runConformanceTests(client, modelsToTest, providerMap, {
            tests, timeout,
          });

          const saved = await evaluationRepository.saveConformanceRun(user.id, report);
          job.status = 'completed';
          job.result = { id: saved.id, summary: report.summary, results: report.results };
          apiLogger.info({ jobId, userId: user.id }, 'Conformance run completed');
        } catch (err) {
          job.status = 'failed';
          job.error = (err as Error).message;
          apiLogger.error({ jobId, err }, 'Conformance run failed');
        }
      })();

      return { jobId, started: true, models: modelsToTest.map(m => m.name) };
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
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const limit = query.limit ? parseInt(query.limit, 10) : 20;
      const runs = await evaluationRepository.getConformanceRuns(user.id, limit);
      return {
        runs: runs.map((r) => ({
          id: r.id, models: r.models, summary: r.summary, results: r.results, createdAt: r.createdAt,
        })),
      };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }), detail: { tags: ['evaluations'] } }
  )

  // ── GET /evaluations/conformance/runs/:id ─────────────────────
  .get(
    '/conformance/runs/:id',
    async ({ user, set, params }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const run = await evaluationRepository.getConformanceRun(params.id);
      if (!run) { set.status = 404; return { error: 'Not found' }; }
      if (run.userId !== user.id && !user.isAdmin) { set.status = 403; return { error: 'Access denied' }; }
      return run;
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['evaluations'] } }
  )

  // ── POST /evaluations/eval/run ────────────────────────────────
  .post(
    '/eval/run',
    async ({ user, body, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }

      // Check for already running job
      for (const job of activeJobs.values()) {
        if (job.userId === user.id && job.status === 'running') {
          set.status = 409;
          return { error: 'An evaluation is already running', type: job.type };
        }
      }

      const { model, dataset: datasetName, evaluators: evaluatorNames, name } = body;

      // Resolve dataset
      const datasetKey = datasetName ?? 'generalQA';
      const dataset = STANDARD_DATASETS[datasetKey];
      if (!dataset) {
        set.status = 400;
        return { error: `Unknown dataset "${datasetKey}". Available: ${Object.keys(STANDARD_DATASETS).join(', ')}` };
      }

      // Resolve evaluators
      let evaluators = ALL_EVALUATORS;
      if (evaluatorNames && evaluatorNames.length > 0) {
        evaluators = ALL_EVALUATORS.filter((e) => evaluatorNames.includes(e.name));
        if (evaluators.length === 0) {
          set.status = 400;
          return { error: `No matching evaluators. Available: ${ALL_EVALUATORS.map((e) => e.name).join(', ')}` };
        }
      }

      const registry = getModelRegistry();
      const modelConfig = await registry.getModel(model) ?? await registry.getModelByModelId(model);
      const provider = modelConfig?.provider ?? 'unknown';
      const modelId = modelConfig?.modelId ?? model;

      const jobId = generateJobId();
      const job: RunningJob = {
        type: 'eval',
        userId: user.id,
        startedAt: new Date(),
        model,
        dataset: datasetKey,
        status: 'running',
      };
      activeJobs.set(jobId, job);

      // Run in background — don't await
      (async () => {
        try {
          // Generate model outputs
          const evalClient = getLiteLLMClient();
          const stampedDataset = [];
          for (const dp of dataset) {
            let output = dp.output;
            let latencyMs: number | undefined;
            if (!output) {
              try {
                const messages: AgentMessage[] = [];
                if (dp.systemPrompt) {
                  messages.push({ role: 'system', content: dp.systemPrompt, timestamp: new Date() });
                }
                messages.push({ role: 'user', content: dp.input, timestamp: new Date() });
                const startMs = Date.now();
                const completion = await evalClient.complete({
                  model: modelId,
                  messages,
                  temperature: 0.3,
                  maxTokens: 1024,
                  extraBody: { ...modelConfig?.metadata?.extraBody, think: true },
                });
                latencyMs = Date.now() - startMs;
                output = completion.content;
              } catch {
                output = '';
              }
            }
            stampedDataset.push({ ...dp, output, model, provider, latencyMs: latencyMs ?? dp.latencyMs });
          }

          // Run evaluators
          const run = await runEvaluation(stampedDataset, evaluators, { name, concurrency: 3 });

          // Persist
          const saved = await evaluationRepository.saveEvalRunWithDataset(user.id, run, datasetKey);

          job.status = 'completed';
          job.result = {
            id: saved.id, name: saved.name, model: saved.model,
            datasetName: saved.datasetName, scores: saved.summary,
            results: run.results, createdAt: saved.createdAt,
          };
          apiLogger.info({ jobId, userId: user.id, model }, 'Eval run completed');
        } catch (err) {
          job.status = 'failed';
          job.error = (err as Error).message;
          apiLogger.error({ jobId, err }, 'Eval run failed');
        }
      })();

      return { jobId, started: true, model, dataset: datasetKey };
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
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const limit = query.limit ? parseInt(query.limit, 10) : 20;
      const runs = await evaluationRepository.getEvalRuns(user.id, limit);
      return {
        runs: runs.map((r) => ({
          id: r.id, name: r.name, model: r.model, dataset: r.datasetName,
          evaluators: r.evaluators, scores: r.summary, results: r.results, createdAt: r.createdAt,
        })),
      };
    },
    { query: t.Object({ limit: t.Optional(t.String()) }), detail: { tags: ['evaluations'] } }
  )

  // ── GET /evaluations/eval/runs/:id ────────────────────────────
  .get(
    '/eval/runs/:id',
    async ({ user, set, params }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const run = await evaluationRepository.getEvalRun(params.id);
      if (!run) { set.status = 404; return { error: 'Not found' }; }
      if (run.userId !== user.id && !user.isAdmin) { set.status = 403; return { error: 'Access denied' }; }
      return run;
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['evaluations'] } }
  )

  // ── GET /evaluations/eval/datasets ───────────────────────────
  .get(
    '/eval/datasets',
    async ({ user, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      return {
        datasets: Object.entries(STANDARD_DATASETS).map(([name, items]) => ({
          name, count: items.length,
        })),
      };
    },
    { detail: { tags: ['evaluations'] } }
  )

  // ── GET /evaluations/eval/evaluators ─────────────────────────
  .get(
    '/eval/evaluators',
    async ({ user, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      return {
        evaluators: ALL_EVALUATORS.map((e) => ({ name: e.name, description: e.description })),
      };
    },
    { detail: { tags: ['evaluations'] } }
  )

  // ── GET /evaluations/eval/summary ────────────────────────────
  .get(
    '/eval/summary',
    async ({ user, set }) => {
      if (!user) { set.status = 401; return { error: 'Not authenticated' }; }
      const summary = await evaluationRepository.getEvalSummary(user.id);
      return { summary };
    },
    { detail: { tags: ['evaluations'] } }
  );

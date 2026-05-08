import { evaluationRepository } from '@/db/repositories/evaluation-repository';
import { generalQA } from '@/models/evaluation/datasets';
import { ALL_EVALUATORS } from '@/models/evaluation/evaluators';
import { runEvaluation } from '@/models/evaluation/runner';
import type { EvalDataPoint } from '@/models/evaluation/types';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { getProviderRouter } from '@/models/providers';
import type { ModelProvider } from '@/models/providers/interface';
import type { ConformanceReport, ConformanceResult } from '@/models/testing/conformance';
import { getTestCaseNames, runConformanceTests } from '@/models/testing/conformance';
import { registerCommand } from './registry';

// ── Formatting helpers ──────────────────────────────────────────────────────

function statusEmoji(status: string): string {
  switch (status) {
    case 'passed': return 'PASS';
    case 'failed': return 'FAIL';
    default: return 'SKIP';
  }
}

/**
 * Format a conformance report as a markdown table grouped by model.
 */
function formatConformanceReport(report: ConformanceReport): string {
  const { results, summary } = report;

  if (results.length === 0) {
    return '_No results. Are any models enabled and their providers available?_';
  }

  // Collect all test names (column headers)
  const testNames = [...new Set(results.map((r) => r.test))];

  // Group results by "model (provider)"
  const byModel = new Map<string, Map<string, ConformanceResult>>();
  for (const r of results) {
    const key = `${r.model}`;
    if (!byModel.has(key)) byModel.set(key, new Map());
    byModel.get(key)!.set(r.test, r);
  }

  // Header row — truncate long test names to keep the table readable
  const shortNames = testNames.map((n) => n.replace(/-/g, ' ').slice(0, 10));
  const header = `| Model | ${shortNames.join(' | ')} |`;
  const divider = `|${'----|'.repeat(testNames.length + 1)}`;

  const rows: string[] = [];
  for (const [model, testMap] of byModel) {
    const cells = testNames.map((name) => {
      const r = testMap.get(name);
      if (!r) return '—';
      return statusEmoji(r.status);
    });
    rows.push(`| \`${model}\` | ${cells.join(' | ')} |`);
  }

  const lines = [
    '**Conformance Results**\n',
    header,
    divider,
    ...rows,
    '',
    `Passed: ${summary.passed} / Failed: ${summary.failed} / Skipped: ${summary.skipped} / Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
  ];

  return lines.join('\n');
}

/**
 * Format quality evaluation summary as a markdown table.
 * model: the model ID, summary: evaluator -> { mean, passRate, count }
 */
function formatQualityResults(
  model: string,
  summary: Record<string, { mean: number; passRate: number; count: number }>,
): string {
  const entries = Object.entries(summary);
  if (entries.length === 0) {
    return '_No evaluator results produced._';
  }

  const header = '| Metric | Score | Pass Rate | Samples |';
  const divider = '|--------|-------|-----------|---------|';

  const rows = entries.map(([metric, stats]) => {
    const score = (stats.mean * 100).toFixed(0) + '%';
    const passRate = (stats.passRate * 100).toFixed(0) + '%';
    const status = stats.passRate >= 0.7 ? 'PASS' : 'FAIL';
    return `| ${metric} | ${score} | ${passRate} (${status}) | ${stats.count} |`;
  });

  return [
    `**Quality Evaluation: \`${model}\`**\n`,
    header,
    divider,
    ...rows,
  ].join('\n');
}

/**
 * Format cross-model comparison from getEvalSummary output.
 */
function formatCompareSummary(
  data: Record<string, Record<string, { mean: number; passRate: number; count: number }>>,
): string {
  if (Object.keys(data).length === 0) {
    return '_No evaluation runs found. Run `/eval quality <model>` first._';
  }

  // Collect all evaluator names across all models
  const allMetrics = [
    ...new Set(Object.values(data).flatMap((m) => Object.keys(m))),
  ].sort();

  const shortMetrics = allMetrics.map((m) => m.slice(0, 8));
  const header = `| Model | ${shortMetrics.join(' | ')} |`;
  const divider = `|${'----|'.repeat(allMetrics.length + 1)}`;

  const rows = Object.entries(data).map(([model, metrics]) => {
    const cells = allMetrics.map((metric) => {
      const s = metrics[metric];
      if (!s) return '—';
      const pct = (s.passRate * 100).toFixed(0) + '%';
      return pct;
    });
    return `| \`${model}\` | ${cells.join(' | ')} |`;
  });

  return [
    '**Cross-Model Comparison** (pass rate per evaluator)\n',
    header,
    divider,
    ...rows,
  ].join('\n');
}

// ── Sub-command implementations ─────────────────────────────────────────────

async function runConformance(
  modelFilter: string | null,
  userId: string,
  notify?: (msg: string) => Promise<void>,
): Promise<string> {
  const registry = getModelRegistry();
  const router = getProviderRouter();
  const client = getLiteLLMClient();

  let models = await registry.getAllModels();
  models = models.filter((m) => m.isEnabled);

  if (modelFilter) {
    models = models.filter(
      (m) => m.modelId === modelFilter || m.name.toLowerCase() === modelFilter.toLowerCase(),
    );
    if (models.length === 0) {
      return `No enabled model found matching \`${modelFilter}\`.`;
    }
  }

  if (models.length === 0) {
    return 'No enabled models found. Enable models in the Models page.';
  }

  if (notify) {
    await notify(`Running conformance tests against ${models.length} model(s)...`);
  }

  // Build provider map
  const providerMap = new Map<string, ModelProvider>();
  for (const p of router.getAllProviders()) {
    providerMap.set(p.name, p);
  }

  const report = await runConformanceTests(client, models, providerMap, { timeout: 30_000 });

  // Persist to DB
  try {
    await evaluationRepository.saveConformanceRun(userId, report);
  } catch {
    // Non-fatal — still return the report
  }

  return formatConformanceReport(report);
}

async function runQuality(
  modelId: string,
  userId: string,
  notify?: (msg: string) => Promise<void>,
): Promise<string> {
  if (!modelId) {
    return 'Usage: `/eval quality <modelId>`\n\nExample: `/eval quality qwen3:14b`';
  }

  const registry = getModelRegistry();
  const allModels = await registry.getAllModels();
  const modelEntry = allModels.find(
    (m) => m.modelId === modelId || m.name.toLowerCase() === modelId.toLowerCase(),
  );

  if (!modelEntry) {
    return `Model \`${modelId}\` not found. Use \`/models\` to list available models.`;
  }

  if (notify) {
    await notify(`Running quality evaluation for \`${modelEntry.modelId}\` (${generalQA.length} data points)...`);
  }

  // We need actual model outputs — get them through the provider router
  const router = getProviderRouter();
  const dataPoints: EvalDataPoint[] = [];

  for (const dp of generalQA) {
    const start = Date.now();
    let output = '';
    try {
      const result = await router.complete({
        model: modelEntry.modelId,
        messages: [{ role: 'user', content: dp.input, timestamp: new Date() }],
        temperature: 0.1,
        maxTokens: 512,
        extraBody: (modelEntry.metadata as Record<string, unknown>)?.extraBody as Record<string, unknown> ?? {},
        userId,
      });
      output = result.content;
    } catch (err) {
      output = `[error: ${err instanceof Error ? err.message : String(err)}]`;
    }

    dataPoints.push({
      ...dp,
      model: modelEntry.modelId,
      provider: modelEntry.provider,
      output,
      latencyMs: Date.now() - start,
    });
  }

  // Run evaluators — use relevance, coherence, completeness (skip faithfulness/tool-accuracy
  // which need extra context; skip latency since we captured it for reference)
  const evaluators = ALL_EVALUATORS.filter((e) =>
    ['relevance', 'coherence', 'completeness', 'latency'].includes(e.name),
  );

  const run = await runEvaluation(dataPoints, evaluators, {
    name: `eval-${modelEntry.modelId}-generalQA`,
    onProgress: notify
      ? (done, total) => notify(`Evaluating... ${done}/${total}`)
      : undefined,
  });

  // Persist
  try {
    await evaluationRepository.saveEvalRunWithDataset(userId, run, 'generalQA');
  } catch {
    // Non-fatal
  }

  return formatQualityResults(modelEntry.modelId, run.summary);
}

async function runCompare(userId: string): Promise<string> {
  const data = await evaluationRepository.getEvalSummary(userId);
  return formatCompareSummary(data);
}

// ── Command registration ────────────────────────────────────────────────────

const HELP_TEXT = [
  '**Model Evaluation Commands**\n',
  '| Sub-command | Description |',
  '|-------------|-------------|',
  '| `/eval conformance` | Run conformance tests against all enabled models |',
  '| `/eval conformance <model>` | Run conformance tests against a specific model |',
  '| `/eval quality <model>` | Run quality evaluation with generalQA dataset |',
  '| `/eval compare` | Show cross-model comparison summary from DB |',
  '',
  `Available conformance tests: ${getTestCaseNames().join(', ')}`,
].join('\n');

registerCommand({
  name: 'eval',
  description: 'Run model evaluation or conformance tests',
  async execute(ctx) {
    const args = ctx.args.trim();

    if (!args) {
      return { response: HELP_TEXT };
    }

    const parts = args.split(/\s+/);
    const sub = parts[0].toLowerCase();
    const rest = parts.slice(1).join(' ').trim();

    try {
      switch (sub) {
        case 'conformance': {
          const response = await runConformance(rest || null, ctx.userId, ctx.notify);
          return { response };
        }

        case 'quality': {
          const response = await runQuality(rest, ctx.userId, ctx.notify);
          return { response };
        }

        case 'compare': {
          const response = await runCompare(ctx.userId);
          return { response };
        }

        default:
          return {
            response: `Unknown sub-command: \`${sub}\`\n\n${HELP_TEXT}`,
          };
      }
    } catch (err) {
      return {
        response: `Evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

#!/usr/bin/env bun
/**
 * CLI runner for model conformance tests.
 *
 * Usage:
 *   bun run src/models/testing/run.ts
 *   bun run src/models/testing/run.ts --provider=ollama
 *   bun run src/models/testing/run.ts --test=basic-completion,tool-calling
 *   bun run src/models/testing/run.ts --model=qwen3:14b
 *   bun run src/models/testing/run.ts --timeout=60000
 *   bun run src/models/testing/run.ts --json          # output JSON report only
 */

import { parseArgs } from 'util';
import type { ModelConfigEntry } from '@/db/schema/models';
import { getLiteLLMClient } from '../litellm-client';
import { getModelRegistry } from '../model-registry';
import { getProviderRouter } from '../providers';
import type { ModelProvider } from '../providers/interface';
import type { ConformanceReport, ConformanceResult } from './conformance';
import { getTestCaseNames, runConformanceTests } from './conformance';

// ── Arg parsing ───────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    provider: { type: 'string', short: 'p' },
    test: { type: 'string', short: 't' },
    model: { type: 'string', short: 'm' },
    timeout: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
  allowPositionals: true,
});

if (args.help) {
  console.log(`
Model Conformance Test Runner

Usage:
  bun run src/models/testing/run.ts [options]

Options:
  --provider=<name>    Filter models by provider (ollama, openai, anthropic, gemini, deepseek)
  --test=<names>       Comma-separated test names to run (default: all)
  --model=<modelId>    Test a specific model by modelId
  --timeout=<ms>       Per-test timeout in milliseconds (default: 30000)
  --json               Output JSON report only (no table)
  --help               Show this help

Available tests:
  ${getTestCaseNames().join(', ')}
`);
  process.exit(0);
}

// ── Provider availability detection ───────────────────────────

interface ProviderAvailability {
  name: string;
  available: boolean;
  reason?: string;
}

function detectProviderAvailability(): ProviderAvailability[] {
  const checks: ProviderAvailability[] = [];

  // Ollama — always attempt (local)
  checks.push({ name: 'ollama', available: true });

  // OpenAI
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  checks.push({
    name: 'openai',
    available: hasOpenAI,
    reason: hasOpenAI ? undefined : 'OPENAI_API_KEY not set',
  });

  // Anthropic
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  checks.push({
    name: 'anthropic',
    available: hasAnthropic,
    reason: hasAnthropic ? undefined : 'ANTHROPIC_API_KEY not set',
  });

  // Gemini
  const hasGemini = !!process.env.GEMINI_API_KEY;
  checks.push({
    name: 'gemini',
    available: hasGemini,
    reason: hasGemini ? undefined : 'GEMINI_API_KEY not set',
  });

  // DeepSeek
  const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
  checks.push({
    name: 'deepseek',
    available: hasDeepSeek,
    reason: hasDeepSeek ? undefined : 'DEEPSEEK_API_KEY not set',
  });

  // LiteLLM — always available if proxy is running
  checks.push({ name: 'litellm', available: true });

  // CLI — skip for conformance (interactive)
  checks.push({ name: 'cli', available: false, reason: 'CLI provider not testable in conformance' });

  // Voyage — embeddings only, check key
  const hasVoyage = !!process.env.VOYAGE_API_KEY;
  checks.push({
    name: 'voyage',
    available: hasVoyage,
    reason: hasVoyage ? undefined : 'VOYAGE_API_KEY not set',
  });

  return checks;
}

// ── Table formatting ──────────────────────────────────────────

function printTable(report: ConformanceReport): void {
  const { results, summary } = report;

  // Group by model
  const byModel = new Map<string, ConformanceResult[]>();
  for (const r of results) {
    const key = `${r.model} (${r.provider})`;
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(r);
  }

  console.log('\n' + '='.repeat(80));
  console.log('MODEL CONFORMANCE TEST RESULTS');
  console.log('='.repeat(80));

  for (const [modelKey, modelResults] of byModel) {
    console.log(`\n--- ${modelKey} ---`);

    const maxNameLen = Math.max(...modelResults.map((r) => r.test.length));

    for (const r of modelResults) {
      const name = r.test.padEnd(maxNameLen + 2);
      const statusIcon =
        r.status === 'passed' ? 'PASS' :
        r.status === 'failed' ? 'FAIL' :
        'SKIP';
      const latency = r.latencyMs !== undefined ? `${r.latencyMs}ms` : '';
      const detail = r.error || r.details || '';

      const line = `  ${name} ${statusIcon.padEnd(6)} ${latency.padStart(8)}  ${detail}`;
      console.log(line);
    }
  }

  console.log('\n' + '-'.repeat(80));
  console.log(
    `Total: ${summary.total}  |  Passed: ${summary.passed}  |  Failed: ${summary.failed}  |  Skipped: ${summary.skipped}  |  Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
  );
  console.log('='.repeat(80) + '\n');
}

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Model Conformance Test Runner');
  console.log('Detecting available providers...\n');

  const availability = detectProviderAvailability();
  const unavailableProviders = new Set<string>();

  for (const pa of availability) {
    const icon = pa.available ? '+' : '-';
    const detail = pa.reason ? ` (${pa.reason})` : '';
    console.log(`  [${icon}] ${pa.name}${detail}`);
    if (!pa.available) unavailableProviders.add(pa.name);
  }

  // Initialize infrastructure
  const client = getLiteLLMClient();
  const router = getProviderRouter();
  const registry = getModelRegistry();

  // Fetch models from DB
  let models: ModelConfigEntry[];
  try {
    models = await registry.getAllModels();
  } catch (err) {
    console.error('\nFailed to fetch models from DB. Is the backend database running?');
    console.error((err as Error).message);
    process.exit(1);
  }

  if (models.length === 0) {
    console.error('\nNo enabled models found in the database.');
    process.exit(1);
  }

  // Apply filters
  if (args.provider) {
    models = models.filter((m) => m.provider === args.provider);
    if (models.length === 0) {
      console.error(`\nNo models found for provider "${args.provider}".`);
      process.exit(1);
    }
  }

  if (args.model) {
    models = models.filter((m) => m.modelId === args.model || m.name === args.model);
    if (models.length === 0) {
      console.error(`\nModel "${args.model}" not found in the database.`);
      process.exit(1);
    }
  }

  // Filter out models whose provider is unavailable
  models = models.filter((m) => !unavailableProviders.has(m.provider));

  if (models.length === 0) {
    console.error('\nNo testable models remaining after filtering unavailable providers.');
    process.exit(1);
  }

  console.log(`\nTesting ${models.length} model(s):`);
  for (const m of models) {
    console.log(`  - ${m.name} (${m.provider}) [${m.modelId}]`);
  }
  console.log('');

  // Build provider map
  const providerMap = new Map<string, ModelProvider>();
  for (const p of router.getAllProviders()) {
    providerMap.set(p.name, p);
  }

  // Parse test filter
  const testFilter = args.test ? String(args.test).split(',').map((t: string) => t.trim()) : undefined;
  const timeout = args.timeout ? parseInt(String(args.timeout), 10) : 30_000;

  // Run tests
  const report = await runConformanceTests(client, models, providerMap, {
    tests: testFilter,
    timeout,
  });

  // Output
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printTable(report);

    // Also write JSON to file for later analysis
    const reportPath = `conformance-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await Bun.write(reportPath, JSON.stringify(report, null, 2));
    console.log(`JSON report written to: ${reportPath}`);
  }

  // Exit with non-zero if any tests failed
  if (report.summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});

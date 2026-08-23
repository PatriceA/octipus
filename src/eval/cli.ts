#!/usr/bin/env tsx
/**
 * Eval CLI entry point.
 *
 * Usage:
 *   bun run src/eval/cli.ts                      # Run all suites
 *   bun run src/eval/cli.ts --suite routing       # Run specific suite
 *   bun run src/eval/cli.ts --tag safety          # Filter by tag
 *   bun run src/eval/cli.ts --model qwen3:14b     # Override model
 *   bun run src/eval/cli.ts --integration         # Run against live backend
 *   bun run src/eval/cli.ts --grader qwen3:14b    # Set grader model for LLM assertions
 *   bun run src/eval/cli.ts --concurrency 4       # Parallel tests
 *   bun run src/eval/cli.ts --detailed            # Show all assertion details
 *   bun run src/eval/cli.ts --json                # Output JSON only
 *   bun run src/eval/cli.ts --no-save             # Don't save results to disk
 */

import { resolve } from 'path';
import { loadSuites } from './loader';
import { compareToBaseline, formatRegressionReport, hasRegressions, resolveBaselinePath } from './regression';
import { reportDetailedToConsole, reportToConsole, saveResults, toJSON } from './reporter';
import { runAllSuites } from './runner';
import type { EvalRunnerOptions } from './types';
import { fileAt } from '@/utils/fs-file';

// ── Argument parsing ─────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  options: EvalRunnerOptions;
  detailed: boolean;
  jsonOnly: boolean;
  noSave: boolean;
  evalDir?: string;
  baseline?: string;
  help: boolean;
} {
  const options: EvalRunnerOptions = {};
  let detailed = false;
  let jsonOnly = false;
  let noSave = false;
  let evalDir: string | undefined;
  let baseline: string | undefined;
  let help = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--suite':
      case '-s':
        options.suite = argv[++i];
        break;
      case '--tag':
      case '-t':
        options.tags = options.tags || [];
        options.tags.push(argv[++i]);
        break;
      case '--model':
      case '-m':
        options.model = argv[++i];
        break;
      case '--grader':
      case '-g':
        options.graderModel = argv[++i];
        break;
      case '--concurrency':
      case '-c':
        options.concurrency = parseInt(argv[++i], 10);
        break;
      case '--integration':
      case '-i':
        options.integration = true;
        break;
      case '--base-url':
        options.baseUrl = argv[++i];
        break;
      case '--detailed':
      case '-d':
        detailed = true;
        break;
      case '--json':
      case '-j':
        jsonOnly = true;
        break;
      case '--no-save':
        noSave = true;
        break;
      case '--eval-dir':
        evalDir = argv[++i];
        break;
      case '--baseline':
        baseline = argv[++i];
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        if (!arg.startsWith('-')) {
          // Positional: treat as suite name
          options.suite = arg;
        } else {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return { options, detailed, jsonOnly, noSave, evalDir, baseline, help };
}

function printHelp() {
  console.log(`
Agent Evaluation Harness

Usage: bun run src/eval/cli.ts [options]

Options:
  --suite, -s <name>      Run a specific suite (matched by filename)
  --tag, -t <tag>         Filter tests by tag (can be repeated)
  --model, -m <model>     Override model for all tests
  --grader, -g <model>    Model for LLM-graded assertions (quality, hallucination)
  --concurrency, -c <n>   Max parallel test executions (default: 1)
  --integration, -i       Run against live backend (POST /api/chat)
  --base-url <url>        Backend URL for integration mode (default: http://localhost:3005)
  --detailed, -d          Show all assertion details (not just failures)
  --json, -j              Output JSON only (no console table)
  --no-save               Don't save results to eval/results/
  --eval-dir <path>       Custom eval directory (default: ./eval)
  --baseline <path>       Gate on regressions against a previous results file.
                          Pass "latest" for the newest file in eval/results/.
                          A test that PASSED in the baseline and fails now exits 1,
                          even if the overall score went up.
  --help, -h              Show this help message

Examples:
  bun run src/eval/cli.ts                          # Run all suites in unit mode
  bun run src/eval/cli.ts -s routing               # Run routing suite only
  bun run src/eval/cli.ts -t quality -m qwen3:14b  # Quality tests with specific model
  bun run src/eval/cli.ts -i -d                    # Integration mode, detailed output
`);
}

// ── Main ─────────────────────────────────────────────────────────────

/**
 * Close the DB (releases the PGlite postmaster.pid lock) and exit. Bare
 * `process.exit()` on an open PGlite connection leaves a stale lock that
 * blocks the next gateway startup with `RuntimeError: Aborted()`.
 */
async function exitClean(code: number): Promise<never> {
  try {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  } catch {
    /* close failure is non-fatal */
  }
  process.exit(code);
}

async function main() {
  const { options, detailed, jsonOnly, noSave, evalDir, baseline, help } = parseArgs(process.argv);

  if (help) {
    printHelp();
    process.exit(0);
  }

  // The model registry + provider router need a live DB connection. When
  // spawned by the running gateway, the child Bun process has a fresh
  // module graph so we re-init here. Without this, getDb() throws and
  // getDefaultModel() swallows the error, surfacing a misleading
  // "No enabled models configured" message.
  let dbInitialized = false;
  if (!options.integration) {
    try {
      const { initializeDb } = await import('@/db/postgres');
      await initializeDb();
      dbInitialized = true;
    } catch (err) {
      console.error(`Database init failed: ${(err as Error).message}`);
      process.exit(2);
    }

    // Vault must be initialized for direct-provider API key lookups (DeepSeek,
    // OpenAI, Anthropic, …). Without this, every vault.getByName/getForAgent
    // call throws "Vault not initialized" and the provider falls back to env
    // vars only — breaking any model whose key lives in the vault. Mirrors
    // the boot sequence in src/index.ts.
    try {
      const { initializeVault } = await import('@/security/vault');
      await initializeVault();
    } catch (err) {
      console.error(`Vault init failed: ${(err as Error).message}`);
      await exitClean(2);
    }

    // Resolve runtime config from DB settings + vault, exactly as src/index.ts
    // does at boot. Without this, `config.litellm.apiKey` stays empty, the
    // LiteLLMClient falls back to the 'sk-litellm' placeholder, and every
    // completion/grader call 401s ("Invalid proxy server token") against a
    // proxy that enforces a master key — which is what broke `eval:quality`.
    // resetLiteLLMClient() drops any client lazily built (with the placeholder)
    // before this point so the next getLiteLLMClient() picks up the real key.
    try {
      const { getConfig } = await import('@/config');
      const storageMode = getConfig().storageMode || 'external';
      const { initializeStorage } = await import('@/db/storage');
      initializeStorage({
        mode: storageMode,
        redis: storageMode === 'external' ? getConfig().redis : undefined,
      });
      const { getSettingsService } = await import('@/config/settings-service');
      await getSettingsService().initialize();
      const { loadRuntimeConfig } = await import('@/config');
      await loadRuntimeConfig();
      const { resetLiteLLMClient } = await import('@/models/litellm-client');
      resetLiteLLMClient();
    } catch (err) {
      console.error(`Runtime config load failed: ${(err as Error).message}`);
      await exitClean(2);
    }
  }

  const dir = evalDir ? resolve(evalDir) : resolve(process.cwd(), 'eval');

  if (!jsonOnly) {
    console.log(`Loading eval suites from ${dir}...`);
    if (options.suite) console.log(`  Filtering suite: ${options.suite}`);
    if (options.tags?.length) console.log(`  Filtering tags: ${options.tags.join(', ')}`);
    if (options.model) console.log(`  Model override: ${options.model}`);
    if (options.integration) console.log(`  Mode: integration (${options.baseUrl || 'http://localhost:3005'})`);
    else console.log('  Mode: unit (direct classifier import)');
    console.log('');
  }

  // Load suites
  const suites = await loadSuites(dir, options.suite);
  if (suites.length === 0) {
    console.error('No eval suites found. Create .yaml files in the eval/ directory.');
    if (dbInitialized) await exitClean(1);
    process.exit(1);
  }

  if (!jsonOnly) {
    console.log(`Found ${suites.length} suite(s) with ${suites.reduce((s, t) => s + t.tests.length, 0)} total tests`);
    console.log('');
  }

  // Run
  const results = await runAllSuites(suites, options);

  // Report
  if (jsonOnly) {
    console.log(toJSON(results));
  } else if (detailed) {
    reportDetailedToConsole(results);
  } else {
    reportToConsole(results);
  }

  // Save
  if (!noSave) {
    const filePath = await saveResults(results, resolve(dir, 'results'));
    if (!jsonOnly) {
      console.log(`Results saved to ${filePath}`);
    }
  }

  // Regression gate. Deliberately independent of the pass/fail exit below: a
  // suite with known-failing tests still has a meaningful baseline, and the
  // question "did this change break something that worked" is not the same
  // question as "is everything green".
  let regressed = false;
  if (baseline) {
    const path = await resolveBaselinePath(baseline, resolve(dir, 'results'));
    if (!path) {
      console.error(`No baseline found (${baseline}). Run once without --baseline to create one.`);
      if (dbInitialized) await exitClean(2);
      process.exit(2);
    }
    const report = compareToBaseline(JSON.parse(await fileAt(path).text()), results);
    if (!jsonOnly) {
      console.log(`\nBaseline: ${path}`);
      console.log(formatRegressionReport(report));
    }
    regressed = hasRegressions(report);
  }

  // Exit code: 0 if all passed, 1 if any failed
  const anyFailed = results.some(r => r.failed > 0) || regressed;
  if (dbInitialized) await exitClean(anyFailed ? 1 : 0);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(async err => {
  console.error('Eval runner failed:', err);
  try {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  } catch { /* non-fatal */ }
  process.exit(2);
});

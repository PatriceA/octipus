#!/usr/bin/env bun
/**
 * Red-team evaluation CLI.
 *
 * Usage:
 *   bun run src/eval/red-team/cli.ts                          # run all plugins
 *   bun run src/eval/red-team/cli.ts --plugin injection        # specific plugin
 *   bun run src/eval/red-team/cli.ts --severity critical       # filter by severity
 *   bun run src/eval/red-team/cli.ts --dry-run                 # generate without executing
 *   bun run src/eval/red-team/cli.ts --list                    # list all test cases
 *   bun run src/eval/red-team/cli.ts --output results.json     # save results to file
 */

import { parseArgs } from 'util';
import { generateRedTeamSuite, redTeamPlugins, runRedTeam } from './index';
import type { RedTeamTest, Severity } from './types';

/**
 * Ensure the database is initialized so the model registry + provider router
 * can be queried. When the CLI is spawned by the running gateway the env is
 * inherited but the child Bun process has a fresh module graph, so the db
 * singleton starts empty and must be re-initialized explicitly.
 */
async function bootstrapDb(): Promise<void> {
  try {
    const { initializeDb } = await import('@/db/postgres');
    await initializeDb();
  } catch (err) {
    console.error(`\n  \x1b[31mDatabase init failed:\x1b[0m ${(err as Error).message}\n`);
    process.exit(2);
  }
}

/**
 * Close the DB connection so PGlite releases its postmaster.pid lock file.
 * Without this, a stale lock can persist in the data dir and block the next
 * gateway startup with `RuntimeError: Aborted()`.
 */
async function shutdownDb(): Promise<void> {
  try {
    const { closeDb } = await import('@/db/postgres');
    await closeDb();
  } catch {
    /* close failure is non-fatal */
  }
}

/**
 * Exit cleanly: tear down the DB, then exit with the given code.
 */
async function exitClean(code: number): Promise<never> {
  await shutdownDb();
  process.exit(code);
}

const PLUGIN_ALIASES: Record<string, string> = {
  injection: 'prompt-injection',
  confusion: 'role-confusion',
  misuse: 'tool-misuse',
  leakage: 'data-leakage',
  drift: 'off-topic-drift',
};

function resolvePluginName(name: string): string {
  return PLUGIN_ALIASES[name] ?? name;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      plugin: { type: 'string', short: 'p', multiple: true },
      severity: { type: 'string', short: 's', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      list: { type: 'boolean', short: 'l', default: false },
      output: { type: 'string', short: 'o' },
      model: { type: 'string', short: 'm' },
      'system-prompt': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
Red-Team Evaluation CLI

Usage:
  bun run src/eval/red-team/cli.ts [options]

Options:
  -p, --plugin <name>      Plugin to run (can repeat). Names or aliases:
                            injection, confusion, misuse, leakage, drift
  -s, --severity <level>   Filter by severity (can repeat): low, medium, high, critical
  -l, --list               List all test cases without running
      --dry-run            Generate tests but skip execution
  -o, --output <file>      Save results to JSON file
  -m, --model <id>         Model to test (defaults to the registry's default)
      --system-prompt <s>  Override the default safety-guardrails system prompt
  -h, --help               Show this help

Available plugins:
${redTeamPlugins.map((p) => `  ${p.name.padEnd(20)} ${p.description}`).join('\n')}
`);
    process.exit(0);
  }

  const severityFilter = values.severity as Severity[] | undefined;
  const pluginFilter = values.plugin?.map(resolvePluginName);

  // List mode: show all tests and exit
  if (values.list) {
    const suite = generateRedTeamSuite({ severity: severityFilter });
    let tests = suite.tests as RedTeamTest[];
    if (pluginFilter?.length) {
      tests = tests.filter((t) => pluginFilter.includes(t.plugin));
    }

    console.log(`\n  Red-Team Test Cases (${tests.length} total)\n`);
    console.log('  ' + '-'.repeat(90));

    let currentPlugin = '';
    for (const test of tests) {
      if (test.plugin !== currentPlugin) {
        currentPlugin = test.plugin;
        console.log(`\n  [${currentPlugin.toUpperCase()}]`);
      }
      const sevColor = {
        critical: '\x1b[31m',
        high: '\x1b[33m',
        medium: '\x1b[36m',
        low: '\x1b[37m',
      }[test.severity] ?? '';
      console.log(`    ${test.id.padEnd(20)} ${sevColor}${test.severity.padEnd(10)}\x1b[0m ${test.description}`);
    }
    console.log();
    process.exit(0);
  }

  // Run evaluation
  console.log('\n  Red-Team Evaluation\n');
  console.log('  ' + '='.repeat(60));

  // Only init the DB for real runs — dry-run doesn't touch the registry.
  if (!values['dry-run']) {
    await bootstrapDb();
  }

  if (values['dry-run']) {
    console.log('  Mode: DRY RUN (tests generated but not executed)\n');
  }

  let evalResult;
  try {
    evalResult = await runRedTeam({
      severity: severityFilter,
      plugins: pluginFilter,
      dryRun: values['dry-run'],
      model: values.model,
      systemPrompt: values['system-prompt'],
    });
  } catch (err) {
    // Fail loud — surface the actual reason (e.g. "no model resolved") so
    // the user can fix it instead of seeing 49 silent FAILs.
    console.error(`\n  \x1b[31mRed-team runner failed:\x1b[0m ${(err as Error).message}\n`);
    await exitClean(2);
    return;
  }

  // Display results
  for (const result of evalResult.results) {
    const isSkipped = !!(result.metadata?.skipped);
    const isError = !!(result.metadata?.error);
    const status = isSkipped ? 'skipped' : isError ? 'error' : result.passed ? 'passed' : 'failed';
    const statusIcon = {
      passed: '\x1b[32mPASS\x1b[0m',
      failed: '\x1b[31mFAIL\x1b[0m',
      skipped: '\x1b[90mSKIP\x1b[0m',
      error:  '\x1b[35mERR \x1b[0m',
    }[status];

    console.log(`  ${statusIcon}  ${result.testId.padEnd(20)} (${result.latencyMs}ms)`);

    if (status === 'failed') {
      for (const ar of result.assertions) {
        if (!ar.passed) {
          console.log(`         \x1b[31m-> ${ar.message}\x1b[0m`);
        }
      }
    } else if (status === 'error') {
      console.log(`         \x1b[35m-> ${result.metadata?.error}\x1b[0m`);
    }
  }

  // Summary
  const summary = evalResult.summary!;
  console.log('\n  ' + '-'.repeat(60));
  console.log(`  Total: ${summary.total}  |  \x1b[32mPassed: ${summary.passed}\x1b[0m  |  \x1b[31mFailed: ${summary.failed}\x1b[0m  |  Errors: ${summary.errors}  |  Skipped: ${summary.skipped}`);
  console.log(`  Score: ${(evalResult.score * 100).toFixed(1)}%  |  Duration: ${summary.durationMs}ms`);
  console.log();

  // Save results if output specified
  if (values.output) {
    await Bun.write(values.output, JSON.stringify(evalResult, null, 2));
    console.log(`  Results saved to: ${values.output}\n`);
  }

  // Exit with failure code if any tests failed
  if (summary.failed > 0 || summary.errors > 0) {
    await exitClean(1);
  }
  await exitClean(0);
}

main().catch(async (error) => {
  console.error('Red-team CLI error:', error);
  await exitClean(1);
});

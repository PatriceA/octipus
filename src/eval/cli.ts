#!/usr/bin/env bun
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
import { runAllSuites } from './runner';
import { reportToConsole, reportDetailedToConsole, saveResults, toJSON } from './reporter';
import type { EvalRunnerOptions } from './types';

// ── Argument parsing ─────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  options: EvalRunnerOptions;
  detailed: boolean;
  jsonOnly: boolean;
  noSave: boolean;
  evalDir?: string;
  help: boolean;
} {
  const options: EvalRunnerOptions = {};
  let detailed = false;
  let jsonOnly = false;
  let noSave = false;
  let evalDir: string | undefined;
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

  return { options, detailed, jsonOnly, noSave, evalDir, help };
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
  --help, -h              Show this help message

Examples:
  bun run src/eval/cli.ts                          # Run all suites in unit mode
  bun run src/eval/cli.ts -s routing               # Run routing suite only
  bun run src/eval/cli.ts -t quality -m qwen3:14b  # Quality tests with specific model
  bun run src/eval/cli.ts -i -d                    # Integration mode, detailed output
`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const { options, detailed, jsonOnly, noSave, evalDir, help } = parseArgs(process.argv);

  if (help) {
    printHelp();
    process.exit(0);
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

  // Exit code: 0 if all passed, 1 if any failed
  const anyFailed = results.some(r => r.failed > 0);
  process.exit(anyFailed ? 1 : 0);
}

main().catch(err => {
  console.error('Eval runner failed:', err);
  process.exit(2);
});

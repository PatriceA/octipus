import { Elysia, } from '@/api/http';
import { readdir, readFile, } from 'fs/promises';
import { resolve, sep } from 'path';
import { apiContext } from '@/api/context';
import { type ChildProcessHandle, spawnProcess } from '@/utils/proc';

const EVAL_RESULTS_DIR = resolve(process.cwd(), 'eval', 'results');

/**
 * A suite name or model id, and nothing that argv would read as an option.
 *
 * `POST /eval/run` puts these straight into the argv of a process that
 * inherits the server's environment, so a value like `--evalDir` or
 * `--output=/etc/x` is an argument-injection, not a suite name (CodeQL
 * js/command-line-injection, alert 15). Spawning without a shell keeps
 * metacharacters inert; it does not stop a value from BEING a flag.
 */
const ARGV_SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function rejectUnsafeArg(label: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  return ARGV_SAFE.test(value)
    ? null
    : `Invalid ${label}: use letters, digits and . _ : / - only, and do not start with "-".`;
}

/**
 * The argv for a run, or the reason it was refused. Exported so the validation
 * and the shape of the spawned command are testable without standing up the
 * route (mirrors `resolveEvalResultPath`).
 */
export function buildEvalRunArgv(opts: {
  type?: 'eval' | 'red-team';
  suite?: string;
  model?: string;
}): { argv: string[] } | { error: string } {
  const error = rejectUnsafeArg('suite', opts.suite) ?? rejectUnsafeArg('model', opts.model);
  if (error) return { error };

  // Node, via the same tsx + markdown-loader invocation every package script
  // uses. This used to spawn `bun`, which the repo stopped running on.
  const argv = ['npx', 'tsx', '--import', './scripts/md-loader.mjs'];
  if (opts.type === 'red-team') {
    argv.push('src/eval/red-team/cli.ts');
  } else {
    argv.push('src/eval/cli.ts');
    if (opts.suite) argv.push('--suite', opts.suite);
  }
  if (opts.model) argv.push('--model', opts.model);
  return { argv };
}

interface SavedEvalFile {
  id: string;
  filename: string;
  timestamp: string;
  suites: unknown[];
  summary: {
    totalSuites: number;
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    averageScore: number;
  };
}

async function listResultFiles(): Promise<SavedEvalFile[]> {
  try {
    const files = await readdir(EVAL_RESULTS_DIR);
    const jsonFiles = files.filter(f => f.endsWith('.json') && f !== '.gitkeep');

    const results: SavedEvalFile[] = [];

    for (const filename of jsonFiles) {
      try {
        const filePath = resolve(EVAL_RESULTS_DIR, filename);
        const content = await readFile(filePath, 'utf-8');
        const data = JSON.parse(content);
        const id = filename.replace('.json', '');

        results.push({
          id,
          filename,
          timestamp: data.timestamp || '',
          suites: data.suites || [],
          summary: data.summary || {
            totalSuites: 0,
            totalTests: 0,
            totalPassed: 0,
            totalFailed: 0,
            averageScore: 0,
          },
        });
      } catch {
        // Skip malformed files
      }
    }

    // Sort by timestamp descending (newest first)
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return results;
  } catch {
    return [];
  }
}

/**
 * Resolve an eval-result id to a path strictly inside EVAL_RESULTS_DIR, or
 * null if the id escapes it. Uses a path-segment check, not a bare
 * `startsWith(EVAL_RESULTS_DIR)` — the latter also accepts sibling dirs that
 * merely share the prefix (e.g. `…/results-evil/x.json`). Exported for tests.
 */
export function resolveEvalResultPath(id: string): string | null {
  const filename = id.endsWith('.json') ? id : `${id}.json`;
  const filePath = resolve(EVAL_RESULTS_DIR, filename);
  if (filePath !== EVAL_RESULTS_DIR && !filePath.startsWith(EVAL_RESULTS_DIR + sep)) return null;
  return filePath;
}

async function getResultById(id: string): Promise<SavedEvalFile | null> {
  try {
    const filename = id.endsWith('.json') ? id : `${id}.json`;
    const filePath = resolveEvalResultPath(id);
    if (!filePath) return null;
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    return {
      id: id.replace('.json', ''),
      filename,
      timestamp: data.timestamp || '',
      suites: data.suites || [],
      summary: data.summary || {
        totalSuites: 0,
        totalTests: 0,
        totalPassed: 0,
        totalFailed: 0,
        averageScore: 0,
      },
    };
  } catch {
    return null;
  }
}

// Track running eval processes
interface EvalRun {
  process: ChildProcessHandle;
  startedAt: Date;
  suite?: string;
  type: string;
  output: string[];
  exitCode?: number | null;
  finished?: boolean;
}
const runningEvals = new Map<string, EvalRun>();
// Keep last completed run for status reporting
let lastCompletedRun: { runId: string; run: EvalRun } | null = null;

export const evalRoutes = new Elysia({ prefix: '/eval' })
  .use(apiContext)

  // Trigger an eval run
  .post('/run', async ({ user, set, body }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }
    // Starting a run spawns a process that inherits the server's environment —
    // its provider keys included — and spends money on model calls. That is an
    // operator action, not something every account holder may trigger.
    if (!user.isAdmin) {
      set.status = 403;
      return { error: 'Admin access required' };
    }

    const { suite, type = 'eval', model } = body as { suite?: string; type?: 'eval' | 'red-team'; model?: string };

    // Prevent multiple simultaneous runs
    if (runningEvals.size > 0) {
      const running = Array.from(runningEvals.values())[0];
      return { error: `An eval is already running (started ${running.startedAt.toISOString()})`, running: true };
    }

    // Fail loud if no model is selected AND no DB default exists, instead of
    // crashing mid-run inside the CLI runner.
    if (!model) {
      const { getModelRegistry } = await import('@/models');
      const registry = getModelRegistry();
      const defaultModel = await registry.getDefaultModel().catch(() => null);
      if (!defaultModel?.modelId) {
        const models = await registry.getAllModels().catch(() => []);
        if (models.length === 0) {
          set.status = 400;
          return {
            error: 'No model selected and no enabled models configured. Register a model (and set one as default), or pass `model` in the request body.',
          };
        }
      }
    }

    const built = buildEvalRunArgv({ type, suite, model });
    if ('error' in built) {
      set.status = 400;
      return { error: built.error };
    }

    const runId = `run-${Date.now()}`;
    const proc = spawnProcess(built.argv, {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    });

    const run: EvalRun = { process: proc, startedAt: new Date(), suite, type, output: [] };
    runningEvals.set(runId, run);

    // Stream stdout/stderr into output buffer
    const collectStream = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          run.output.push(text);
          // Keep last 200 chunks to avoid unbounded memory
          if (run.output.length > 200) run.output.shift();
        }
      } catch { /* stream closed */ }
    };
    collectStream(proc.stdout as ReadableStream<Uint8Array>);
    collectStream(proc.stderr as ReadableStream<Uint8Array>);

    // Track completion
    proc.exited.then((code) => {
      run.exitCode = code;
      run.finished = true;
      lastCompletedRun = { runId, run: { ...run, process: undefined as any } };
      runningEvals.delete(runId);
    });

    return { runId, started: true, type, suite: suite || 'all' };
  })

  // Check eval run status
  .get('/status', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }

    if (runningEvals.size === 0) {
      // Return last completed run info if available
      if (lastCompletedRun) {
        const { runId, run } = lastCompletedRun;
        return {
          running: false,
          lastRun: {
            runId,
            type: run.type,
            suite: run.suite || 'all',
            exitCode: run.exitCode,
            output: run.output.join('').slice(-4000), // Last 4KB of output
          },
        };
      }
      return { running: false };
    }

    const [runId, info] = Array.from(runningEvals.entries())[0];
    return {
      running: true,
      runId,
      type: info.type,
      suite: info.suite || 'all',
      startedAt: info.startedAt.toISOString(),
      elapsedMs: Date.now() - info.startedAt.getTime(),
      output: info.output.join('').slice(-4000), // Last 4KB of live output
    };
  })

  // List all eval results
  .get('/results', async ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }

    const results = await listResultFiles();
    return {
      results: results.map(r => ({
        id: r.id,
        filename: r.filename,
        timestamp: r.timestamp,
        summary: r.summary,
        // Include suite-level summaries without full test results
        suites: (r.suites as any[]).map(s => ({
          suite: s.suite,
          totalTests: s.totalTests,
          passed: s.passed,
          failed: s.failed,
          score: s.score,
          duration: s.duration,
          timestamp: s.timestamp,
        })),
      })),
    };
  })

  // Get a specific eval result with full detail
  .get('/results/:id', async ({ user, set, params }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }

    const result = await getResultById(params.id);
    if (!result) {
      set.status = 404;
      return { error: 'Eval result not found' };
    }

    return result;
  })

  // Compare multiple eval results
  .get('/compare', async ({ user, set, query }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Not authenticated' };
    }

    const ids = ((query as any).ids || '').split(',').filter(Boolean);
    if (ids.length < 2) {
      set.status = 400;
      return { error: 'Provide at least 2 result IDs via ?ids=a,b' };
    }

    const results: SavedEvalFile[] = [];
    for (const id of ids) {
      const r = await getResultById(id.trim());
      if (r) results.push(r);
    }

    if (results.length < 2) {
      set.status = 404;
      return { error: 'Could not find enough results to compare' };
    }

    // Build comparison matrix: collect all unique test IDs
    const allTestIds = new Set<string>();
    for (const r of results) {
      for (const suite of r.suites as any[]) {
        for (const test of suite.results || []) {
          allTestIds.add(test.testId);
        }
      }
    }

    // Build matrix: testId -> { [evalId]: result }
    const matrix: Record<string, Record<string, unknown>> = {};
    for (const testId of allTestIds) {
      matrix[testId] = {};
      for (const r of results) {
        for (const suite of r.suites as any[]) {
          const test = (suite.results || []).find((t: any) => t.testId === testId);
          if (test) {
            matrix[testId][r.id] = {
              passed: test.passed,
              score: test.score,
              latencyMs: test.latencyMs,
              assertions: test.assertions,
            };
          }
        }
      }
    }

    return {
      evalRuns: results.map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        summary: r.summary,
      })),
      testIds: [...allTestIds],
      matrix,
    };
  });

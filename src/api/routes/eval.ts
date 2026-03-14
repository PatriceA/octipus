import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { resolve } from 'path';
import { readdir, readFile, stat } from 'fs/promises';

const EVAL_RESULTS_DIR = resolve(process.cwd(), 'eval', 'results');

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

async function getResultById(id: string): Promise<SavedEvalFile | null> {
  try {
    const filename = id.endsWith('.json') ? id : `${id}.json`;
    const filePath = resolve(EVAL_RESULTS_DIR, filename);
    // Prevent path traversal
    if (!filePath.startsWith(EVAL_RESULTS_DIR)) return null;
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
  process: ReturnType<typeof Bun.spawn>;
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

    const { suite, type = 'eval' } = body as { suite?: string; type?: 'eval' | 'red-team' };

    // Prevent multiple simultaneous runs
    if (runningEvals.size > 0) {
      const running = Array.from(runningEvals.values())[0];
      return { error: `An eval is already running (started ${running.startedAt.toISOString()})`, running: true };
    }

    const runId = `run-${Date.now()}`;
    const args: string[] = [];

    if (type === 'red-team') {
      args.push('run', 'src/eval/red-team/cli.ts');
    } else {
      args.push('run', 'src/eval/cli.ts');
      if (suite) args.push('--suite', suite);
    }

    const proc = Bun.spawn(['bun', ...args], {
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

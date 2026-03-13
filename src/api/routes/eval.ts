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

export const evalRoutes = new Elysia({ prefix: '/eval' })
  .use(apiContext)

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

'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  FlaskConical,
  RefreshCw,
  ArrowLeft,
  CheckCircle,
  XCircle,
  Clock,
  GitCompare,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { ScoreBar } from '@/components/eval/ScoreBar';
import { ResultsTable } from '@/components/eval/ResultsTable';
import { PassRateDonut, AssertionBreakdown, LatencyHistogram } from '@/components/eval/EvalCharts';

interface AssertionResult {
  type: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
  score: number;
  message?: string;
}

interface EvalResult {
  suiteId: string;
  testId: string;
  input: string;
  output: string;
  assertions: AssertionResult[];
  passed: boolean;
  score: number;
  latencyMs: number;
  tokenCount?: { input: number; output: number };
  metadata?: Record<string, unknown>;
  timestamp: string;
}

interface EvalSuite {
  suite: string;
  totalTests: number;
  passed: number;
  failed: number;
  score: number;
  results: EvalResult[];
  duration: number;
  timestamp: string;
}

interface EvalDetail {
  id: string;
  filename: string;
  timestamp: string;
  suites: EvalSuite[];
  summary: {
    totalSuites: number;
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    averageScore?: number;
    passRate?: number;
  };
}

type FilterType = 'all' | 'passed' | 'failed';

export default function EvalDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [data, setData] = useState<EvalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [activeSuite, setActiveSuite] = useState<string | null>(null);
  const [assertionTypeFilter, setAssertionTypeFilter] = useState<string>('');

  const fetchDetail = useCallback(async () => {
    try {
      const result = await api.get<EvalDetail>(`/eval/results/${encodeURIComponent(id)}`);
      setData(result);
      if (result.suites.length > 0 && !activeSuite) {
        setActiveSuite(result.suites[0].suite);
      }
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, activeSuite]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin text-gray-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Link
          href="/eval"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Evaluations
        </Link>
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl px-4 py-3 text-red-700 dark:text-red-300 text-sm">
          {error || 'Eval result not found'}
        </div>
      </div>
    );
  }

  const currentSuite = data.suites.find(s => s.suite === activeSuite) || data.suites[0];
  const allResults = currentSuite?.results || [];

  // Collect unique assertion types for filter
  const assertionTypes = new Set<string>();
  for (const r of allResults) {
    for (const a of r.assertions) {
      assertionTypes.add(a.type);
    }
  }

  return (
    <div className="space-y-6">
      {/* Back + header */}
      <div>
        <Link
          href="/eval"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Evaluations
        </Link>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary-100 dark:bg-primary-950/40 flex items-center justify-center">
              <FlaskConical className="w-5 h-5 text-primary-700 dark:text-primary-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {data.suites.length === 1 ? data.suites[0].suite : `Eval Run`}
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400" suppressHydrationWarning>
                {formatDate(data.timestamp)}
              </p>
            </div>
          </div>
          <Link
            href={`/eval/compare?ids=${id}`}
            className="px-3 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-2 text-sm"
          >
            <GitCompare className="w-4 h-4" />
            Compare
          </Link>
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{data.summary.totalTests}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Tests</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">{data.summary.totalPassed}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Passed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-2xl font-bold text-red-600 dark:text-red-400">{data.summary.totalFailed}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Failed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 text-center">
            <ScoreBar score={data.summary.passRate ?? data.summary.averageScore ?? 0} />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">Score</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {data.suites.reduce((s, suite) => s + (suite.duration || 0), 0) > 1000
                ? `${(data.suites.reduce((s, suite) => s + (suite.duration || 0), 0) / 1000).toFixed(1)}s`
                : `${data.suites.reduce((s, suite) => s + (suite.duration || 0), 0)}ms`}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Duration</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      {currentSuite && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <PassRateDonut passed={currentSuite.passed} failed={currentSuite.failed} />
          <AssertionBreakdown results={allResults} />
          <LatencyHistogram results={allResults} />
        </div>
      )}

      {/* Suite tabs (if multiple) */}
      {data.suites.length > 1 && (
        <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
          {data.suites.map(suite => (
            <button
              key={suite.suite}
              onClick={() => setActiveSuite(suite.suite)}
              className={cn(
                'px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer',
                activeSuite === suite.suite
                  ? 'border-primary-500 text-primary-700 dark:text-primary-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
              )}
            >
              {suite.suite}
              <span className={cn(
                'ml-2 text-xs px-1.5 py-0.5 rounded-full',
                suite.failed > 0
                  ? 'bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-400'
                  : 'bg-green-100 text-green-700 dark:bg-green-950/30 dark:text-green-400'
              )}>
                {suite.passed}/{suite.totalTests}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          {(['all', 'passed', 'failed'] as FilterType[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md transition-colors capitalize cursor-pointer',
                filter === f
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'
              )}
            >
              {f === 'all' && 'All'}
              {f === 'passed' && (
                <span className="flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Passed</span>
              )}
              {f === 'failed' && (
                <span className="flex items-center gap-1"><XCircle className="w-3 h-3" /> Failed</span>
              )}
            </button>
          ))}
        </div>

        {assertionTypes.size > 0 && (
          <select
            value={assertionTypeFilter}
            onChange={e => setAssertionTypeFilter(e.target.value)}
            className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 border-0 rounded-lg text-gray-700 dark:text-gray-300"
          >
            <option value="">All assertion types</option>
            {Array.from(assertionTypes).map(type => (
              <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>
            ))}
          </select>
        )}
      </div>

      {/* Results Table */}
      <ResultsTable
        results={allResults}
        filter={filter}
        assertionTypeFilter={assertionTypeFilter || undefined}
      />
    </div>
  );
}

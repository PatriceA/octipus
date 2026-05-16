'use client';

import {
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AssertionBadge } from '@/components/eval/AssertionBadge';
import { ScoreBar } from '@/components/eval/ScoreBar';
import { Card, CardContent, } from '@/components/ui/card';
import { api } from '@/lib/api';
import { cn, truncate } from '@/lib/utils';

type AttackCategory = 'injection' | 'confusion' | 'misuse' | 'leakage' | 'drift';
type Severity = 'low' | 'medium' | 'high' | 'critical';

interface RedTeamResult {
  testId: string;
  input: string;
  output: string;
  passed: boolean;
  score: number;
  latencyMs: number;
  assertions: {
    type: string;
    passed: boolean;
    expected: unknown;
    actual: unknown;
    score: number;
    message?: string;
  }[];
  metadata?: {
    plugin?: string;
    severity?: Severity;
    category?: AttackCategory;
    expectedDefense?: string;
    [key: string]: unknown;
  };
}

interface EvalSuite {
  suite: string;
  totalTests: number;
  passed: number;
  failed: number;
  score: number;
  results: RedTeamResult[];
  duration: number;
}

interface EvalListItem {
  id: string;
  timestamp: string;
  suites: EvalSuite[];
  summary: {
    totalTests: number;
    totalPassed: number;
    totalFailed: number;
    averageScore: number;
  };
}

const CATEGORY_CONFIG: Record<AttackCategory, { label: string; icon: typeof Shield; color: string }> = {
  injection: { label: 'Prompt Injection', icon: ShieldAlert, color: 'text-red-400' },
  confusion: { label: 'Role Confusion', icon: AlertTriangle, color: 'text-orange-400' },
  misuse: { label: 'Tool Misuse', icon: ShieldAlert, color: 'text-yellow-400' },
  leakage: { label: 'Data Leakage', icon: Shield, color: 'text-purple-400' },
  drift: { label: 'Off-Topic Drift', icon: AlertTriangle, color: 'text-blue-400' },
};

const SEVERITY_CONFIG: Record<Severity, { label: string; color: string; bg: string }> = {
  critical: { label: 'Critical', color: 'text-red-400', bg: 'bg-red-950/30' },
  high: { label: 'High', color: 'text-orange-400', bg: 'bg-orange-950/30' },
  medium: { label: 'Medium', color: 'text-yellow-400', bg: 'bg-yellow-950/30' },
  low: { label: 'Low', color: 'text-blue-400', bg: 'bg-blue-950/30' },
};

function SeverityBadge({ severity }: { severity: Severity }) {
  const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.medium;
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium', config.bg, config.color)}>
      {config.label}
    </span>
  );
}

export default function RedTeamPage() {
  const [results, setResults] = useState<EvalListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedTest, setExpandedTest] = useState<string | null>(null);

  const fetchResults = useCallback(async () => {
    try {
      const data = await api.get<{ results: EvalListItem[] }>('/eval/results');
      setResults(data.results || []);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  // Find red-team suites across all results. We need full data for the latest red-team run.
  const [redTeamData, setRedTeamData] = useState<RedTeamResult[]>([]);
  const [redTeamLoading, setRedTeamLoading] = useState(false);

  // Find the latest result that contains a red-team suite
  const latestRedTeamRun = useMemo(() => {
    for (const r of results) {
      const rtSuite = r.suites.find(s =>
        s.suite.toLowerCase().includes('red') ||
        s.suite.toLowerCase().includes('security') ||
        s.suite.toLowerCase().includes('safety')
      );
      if (rtSuite) return { run: r, suiteName: rtSuite.suite };
    }
    return null;
  }, [results]);

  // Fetch full detail for the red-team run
  useEffect(() => {
    if (!latestRedTeamRun) return;
    setRedTeamLoading(true);
    api.get<EvalListItem>(`/eval/results/${encodeURIComponent(latestRedTeamRun.run.id)}`)
      .then(data => {
        const rtSuite = data.suites.find(s => s.suite === latestRedTeamRun.suiteName);
        if (rtSuite) {
          setRedTeamData(rtSuite.results);
        } else {
          // Use all results if suite name doesn't match exactly
          const allResults = data.suites.flatMap(s => s.results);
          setRedTeamData(allResults);
        }
      })
      .catch(() => { /* silent */ })
      .finally(() => setRedTeamLoading(false));
  }, [latestRedTeamRun]);

  // Group by category
  const byCategory = useMemo(() => {
    const groups: Record<string, RedTeamResult[]> = {};
    for (const r of redTeamData) {
      const category = (r.metadata?.category as string) || 'unknown';
      if (!groups[category]) groups[category] = [];
      groups[category].push(r);
    }
    return groups;
  }, [redTeamData]);

  // Category defense rates
  const categoryStats = useMemo(() => {
    return Object.entries(byCategory).map(([category, tests]) => {
      const defended = tests.filter(t => t.passed).length;
      return {
        category,
        total: tests.length,
        defended,
        breached: tests.length - defended,
        rate: tests.length > 0 ? defended / tests.length : 0,
      };
    });
  }, [byCategory]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-6 h-6 animate-spin text-on-surface-variant" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back + header */}
      <div>
        <Link
          href="/eval"
          className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-on-surface mb-3"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Evaluations
        </Link>

        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-950/40 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-on-surface">Red Team Results</h1>
            <p className="text-sm text-on-surface-variant">Security and safety evaluation results</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-800 rounded-xl px-4 py-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      {redTeamData.length === 0 && !redTeamLoading ? (
        <Card>
          <CardContent className="text-center py-12">
            <ShieldAlert className="w-12 h-12 mx-auto mb-3 text-on-surface-variant" />
            <p className="text-on-surface-variant">No red-team results found</p>
            <p className="text-sm text-on-surface-variant mt-1">
              Run red-team eval: <code className="bg-surface-container-high px-1.5 py-0.5 rounded text-xs">bun run src/eval/red-team/cli.ts</code>
            </p>
          </CardContent>
        </Card>
      ) : redTeamLoading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="w-5 h-5 animate-spin text-on-surface-variant mr-2" />
          <span className="text-on-surface-variant">Loading red-team results...</span>
        </div>
      ) : (
        <>
          {/* Defense success rate by category */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
            {categoryStats.map(stat => {
              const config = CATEGORY_CONFIG[stat.category as AttackCategory];
              const Icon = config?.icon || Shield;
              return (
                <Card key={stat.category}>
                  <CardContent className="py-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Icon className={cn('w-4 h-4', config?.color || 'text-on-surface-variant')} />
                      <span className="text-sm font-medium text-on-surface capitalize">
                        {config?.label || stat.category}
                      </span>
                    </div>
                    <ScoreBar score={stat.rate} />
                    <div className="flex justify-between mt-2 text-xs text-on-surface-variant">
                      <span className="flex items-center gap-1">
                        <ShieldCheck className="w-3 h-3 text-green-500" />
                        {stat.defended} defended
                      </span>
                      <span className="flex items-center gap-1">
                        <XCircle className="w-3 h-3 text-red-500" />
                        {stat.breached} breached
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/* Results by category */}
          {Object.entries(byCategory).map(([category, tests]) => {
            const config = CATEGORY_CONFIG[category as AttackCategory];
            const Icon = config?.icon || Shield;

            return (
              <div key={category}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon className={cn('w-5 h-5', config?.color || 'text-on-surface-variant')} />
                  <h2 className="text-lg font-semibold text-on-surface capitalize">
                    {config?.label || category}
                  </h2>
                  <span className="text-sm text-on-surface-variant">
                    ({tests.filter(t => t.passed).length}/{tests.length} defended)
                  </span>
                </div>

                <div className="space-y-2">
                  {tests.map(test => {
                    const isExpanded = expandedTest === test.testId;
                    const severity = (test.metadata?.severity as Severity) || 'medium';

                    return (
                      <div
                        key={test.testId}
                        className="bg-surface-container rounded-xs ring-1 ring-outline-variant/10 overflow-hidden"
                      >
                        <button
                          onClick={() => setExpandedTest(isExpanded ? null : test.testId)}
                          className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-surface-container-high cursor-pointer"
                        >
                          {test.passed ? (
                            <ShieldCheck className="w-5 h-5 text-green-500 shrink-0" />
                          ) : (
                            <XCircle className="w-5 h-5 text-red-500 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-mono text-on-surface">
                                {test.testId}
                              </span>
                              <SeverityBadge severity={severity} />
                              {test.metadata?.plugin && (
                                <span className="text-xs text-on-surface-variant">
                                  {test.metadata.plugin as string}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-on-surface-variant mt-0.5 truncate">
                              {truncate(test.input, 120)}
                            </p>
                          </div>
                          <ScoreBar score={test.score} size="sm" />
                        </button>

                        {isExpanded && (
                          <div className="px-4 py-3 border-t border-outline-variant/10 space-y-3">
                            {/* Attack prompt */}
                            <div>
                              <p className="text-xs font-medium text-on-surface-variant mb-1">Attack Prompt</p>
                              <pre className="text-sm text-on-surface/80 whitespace-pre-wrap bg-red-950/10 rounded-lg p-3 border border-red-900/30 max-h-40 overflow-y-auto">
                                {test.input}
                              </pre>
                            </div>

                            {/* System response */}
                            {test.output && (
                              <div>
                                <p className="text-xs font-medium text-on-surface-variant mb-1">System Response</p>
                                <pre className="text-sm text-on-surface/80 whitespace-pre-wrap bg-surface-container-low rounded-lg p-3 border border-outline-variant/10 max-h-40 overflow-y-auto">
                                  {test.output}
                                </pre>
                              </div>
                            )}

                            {/* Expected defense */}
                            {test.metadata?.expectedDefense && (
                              <div>
                                <p className="text-xs font-medium text-on-surface-variant mb-1">Expected Defense</p>
                                <p className="text-sm text-on-surface-variant">
                                  {test.metadata.expectedDefense as string}
                                </p>
                              </div>
                            )}

                            {/* Assertions */}
                            <div>
                              <p className="text-xs font-medium text-on-surface-variant mb-1">Assertions</p>
                              <div className="flex flex-wrap gap-1.5">
                                {test.assertions.map((a, i) => (
                                  <AssertionBadge key={i} type={a.type} passed={a.passed} />
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

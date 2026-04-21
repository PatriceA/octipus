'use client';

import { CheckCircle, ChevronDown, ChevronRight, Clock, XCircle } from 'lucide-react';
import { useState } from 'react';
import { cn, truncate } from '@/lib/utils';
import { AssertionBadge } from './AssertionBadge';
import { ScoreBar } from './ScoreBar';

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

interface ResultsTableProps {
  results: EvalResult[];
  filter?: 'all' | 'passed' | 'failed';
  assertionTypeFilter?: string;
}

function ExpandedRow({ result }: { result: EvalResult }) {
  return (
    <tr>
      <td colSpan={6} className="px-4 py-3 bg-[#131313]">
        <div className="space-y-3">
          {/* Input */}
          <div>
            <p className="text-xs font-medium text-on-surface-variant mb-1">Input</p>
            <pre className="text-sm text-white/80 whitespace-pre-wrap bg-[#0e0e0e] rounded-lg p-3 border border-outline-variant/10 max-h-40 overflow-y-auto">
              {result.input}
            </pre>
          </div>

          {/* Output */}
          {result.output && (
            <div>
              <p className="text-xs font-medium text-on-surface-variant mb-1">Output</p>
              <pre className="text-sm text-white/80 whitespace-pre-wrap bg-[#0e0e0e] rounded-lg p-3 border border-outline-variant/10 max-h-40 overflow-y-auto">
                {result.output}
              </pre>
            </div>
          )}

          {/* Token count */}
          {result.tokenCount && (
            <div className="flex gap-4 text-xs text-on-surface-variant">
              <span>Input tokens: <span className="font-mono">{result.tokenCount.input}</span></span>
              <span>Output tokens: <span className="font-mono">{result.tokenCount.output}</span></span>
            </div>
          )}

          {/* Assertions */}
          <div>
            <p className="text-xs font-medium text-on-surface-variant mb-2">Assertions</p>
            <div className="space-y-1.5">
              {result.assertions.map((a, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-3 px-3 py-2 rounded-lg text-sm',
                    a.passed
                      ? 'bg-green-950/20'
                      : 'bg-red-950/20'
                  )}
                >
                  {a.passed ? (
                    <CheckCircle className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <AssertionBadge type={a.type} passed={a.passed} compact />
                      <span className="text-xs text-on-surface-variant font-mono">
                        score: {(a.score * 100).toFixed(0)}%
                      </span>
                    </div>
                    {a.message && (
                      <p className="text-xs text-on-surface-variant">{a.message}</p>
                    )}
                    <div className="flex gap-4 mt-1 text-xs text-on-surface-variant">
                      <span>Expected: <code className="font-mono">{JSON.stringify(a.expected)}</code></span>
                      <span>Actual: <code className="font-mono">{JSON.stringify(a.actual)}</code></span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

export function ResultsTable({ results, filter = 'all', assertionTypeFilter }: ResultsTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpand = (testId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(testId)) next.delete(testId);
      else next.add(testId);
      return next;
    });
  };

  let filtered = results;
  if (filter === 'passed') filtered = filtered.filter(r => r.passed);
  if (filter === 'failed') filtered = filtered.filter(r => !r.passed);
  if (assertionTypeFilter) {
    filtered = filtered.filter(r =>
      r.assertions.some(a => a.type === assertionTypeFilter)
    );
  }

  return (
    <div className="bg-[#1a1a1a] rounded-[1rem] ring-1 ring-outline-variant/10 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-outline-variant/10">
              <th className="w-8 px-3 py-3" />
              <th className="px-4 py-3 text-left text-sm font-medium text-on-surface-variant">Test ID</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-on-surface-variant">Input</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-on-surface-variant">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-on-surface-variant">Score</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-on-surface-variant">Latency</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-on-surface-variant">
                  No results match the current filter.
                </td>
              </tr>
            ) : (
              filtered.map((result) => {
                const isExpanded = expanded.has(result.testId);
                return (
                  <>
                    <tr
                      key={result.testId}
                      onClick={() => toggleExpand(result.testId)}
                      className="border-b border-outline-variant/10 hover:bg-[#20201f] cursor-pointer"
                    >
                      <td className="px-3 py-3">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-on-surface-variant" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-on-surface-variant" />
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono text-white">
                        {result.testId}
                      </td>
                      <td className="px-4 py-3 text-sm text-on-surface-variant max-w-xs truncate">
                        {truncate(result.input, 80)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                          result.passed
                            ? 'bg-green-950/30 text-green-400'
                            : 'bg-red-950/30 text-red-400'
                        )}>
                          {result.passed ? (
                            <><CheckCircle className="w-3 h-3" /> Pass</>
                          ) : (
                            <><XCircle className="w-3 h-3" /> Fail</>
                          )}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <ScoreBar score={result.score} size="sm" />
                      </td>
                      <td className="px-4 py-3 text-sm font-mono text-on-surface-variant">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {result.latencyMs > 1000
                            ? `${(result.latencyMs / 1000).toFixed(1)}s`
                            : `${result.latencyMs}ms`}
                        </span>
                      </td>
                    </tr>
                    {isExpanded && <ExpandedRow key={`${result.testId}-expanded`} result={result} />}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

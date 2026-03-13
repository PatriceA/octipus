'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { truncate } from '@/lib/utils';
import { ScoreBar } from './ScoreBar';
import { AssertionBadge } from './AssertionBadge';
import { ChevronDown, ChevronRight, CheckCircle, XCircle, Clock } from 'lucide-react';

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
      <td colSpan={6} className="px-4 py-3 bg-gray-50/50 dark:bg-gray-800/30">
        <div className="space-y-3">
          {/* Input */}
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Input</p>
            <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap bg-white dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700 max-h-40 overflow-y-auto">
              {result.input}
            </pre>
          </div>

          {/* Output */}
          {result.output && (
            <div>
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Output</p>
              <pre className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap bg-white dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-700 max-h-40 overflow-y-auto">
                {result.output}
              </pre>
            </div>
          )}

          {/* Token count */}
          {result.tokenCount && (
            <div className="flex gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span>Input tokens: <span className="font-mono">{result.tokenCount.input}</span></span>
              <span>Output tokens: <span className="font-mono">{result.tokenCount.output}</span></span>
            </div>
          )}

          {/* Assertions */}
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Assertions</p>
            <div className="space-y-1.5">
              {result.assertions.map((a, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-start gap-3 px-3 py-2 rounded-lg text-sm',
                    a.passed
                      ? 'bg-green-50/50 dark:bg-green-950/20'
                      : 'bg-red-50/50 dark:bg-red-950/20'
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
                      <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                        score: {(a.score * 100).toFixed(0)}%
                      </span>
                    </div>
                    {a.message && (
                      <p className="text-xs text-gray-600 dark:text-gray-400">{a.message}</p>
                    )}
                    <div className="flex gap-4 mt-1 text-xs text-gray-500 dark:text-gray-400">
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
    <div className="bg-white dark:bg-[#131C2E] rounded-xl shadow-sm ring-1 ring-primary-100 dark:ring-[#1E2D45] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-700">
              <th className="w-8 px-3 py-3" />
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Test ID</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Input</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Score</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-gray-500 dark:text-gray-400">Latency</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
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
                      className="border-b border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/30 cursor-pointer"
                    >
                      <td className="px-3 py-3">
                        {isExpanded ? (
                          <ChevronDown className="w-4 h-4 text-gray-400" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-gray-400" />
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm font-mono text-gray-900 dark:text-gray-100">
                        {result.testId}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300 max-w-xs truncate">
                        {truncate(result.input, 80)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                          result.passed
                            ? 'bg-green-100 text-green-800 dark:bg-green-950/30 dark:text-green-400'
                            : 'bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-400'
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
                      <td className="px-4 py-3 text-sm font-mono text-gray-600 dark:text-gray-300">
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

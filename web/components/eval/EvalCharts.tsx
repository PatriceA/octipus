'use client';

import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

interface AssertionResult {
  type: string;
  passed: boolean;
  score: number;
}

interface EvalResult {
  passed: boolean;
  score: number;
  latencyMs: number;
  assertions: AssertionResult[];
}

// ── Pass Rate Donut ──────────────────────────────────────────────────

interface PassRateDonutProps {
  passed: number;
  failed: number;
}

export function PassRateDonut({ passed, failed }: PassRateDonutProps) {
  const data = [
    { name: 'Passed', value: passed },
    { name: 'Failed', value: failed },
  ];
  const COLORS = ['#22c55e', '#ef4444'];
  const total = passed + failed;
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pass Rate</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-48 relative">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={75}
                paddingAngle={2}
                dataKey="value"
              >
                {data.map((_, index) => (
                  <Cell key={index} fill={COLORS[index]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number, name: string) => [`${value} tests`, name]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <p className="text-2xl font-bold text-white">{pct}%</p>
              <p className="text-xs text-on-surface-variant">{passed}/{total}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Assertion Type Breakdown ─────────────────────────────────────────

interface AssertionBreakdownProps {
  results: EvalResult[];
}

export function AssertionBreakdown({ results }: AssertionBreakdownProps) {
  // Group assertions by type
  const typeCounts: Record<string, { passed: number; failed: number }> = {};
  for (const r of results) {
    for (const a of r.assertions) {
      if (!typeCounts[a.type]) typeCounts[a.type] = { passed: 0, failed: 0 };
      if (a.passed) typeCounts[a.type].passed++;
      else typeCounts[a.type].failed++;
    }
  }

  const data = Object.entries(typeCounts).map(([type, counts]) => ({
    type: type.replace(/_/g, ' '),
    passed: counts.passed,
    failed: counts.failed,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assertions by Type</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" />
              <YAxis type="category" dataKey="type" width={100} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="passed" stackId="a" fill="#22c55e" name="Passed" />
              <Bar dataKey="failed" stackId="a" fill="#ef4444" name="Failed" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Latency Distribution ─────────────────────────────────────────────

interface LatencyHistogramProps {
  results: EvalResult[];
}

export function LatencyHistogram({ results }: LatencyHistogramProps) {
  // Create histogram buckets
  const buckets = [
    { label: '<100ms', min: 0, max: 100 },
    { label: '100-500ms', min: 100, max: 500 },
    { label: '500ms-1s', min: 500, max: 1000 },
    { label: '1-3s', min: 1000, max: 3000 },
    { label: '3-5s', min: 3000, max: 5000 },
    { label: '>5s', min: 5000, max: Infinity },
  ];

  const data = buckets.map(bucket => ({
    range: bucket.label,
    count: results.filter(r => r.latencyMs >= bucket.min && r.latencyMs < bucket.max).length,
  })).filter(d => d.count > 0 || true); // keep all buckets

  return (
    <Card>
      <CardHeader>
        <CardTitle>Latency Distribution</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="range" tick={{ fontSize: 11 }} />
              <YAxis allowDecimals={false} />
              <Tooltip formatter={(value: number) => [`${value} tests`, 'Count']} />
              <Bar dataKey="count" fill="#0ea5e9" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

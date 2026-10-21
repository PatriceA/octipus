/**
 * Decision-model shadow report — per call site, how often the decision model
 * agreed with the path that actually decided (docs/plans/decision-models.md).
 * This is the number that justifies flipping a site's *_LIVE constant.
 *
 * Reads the backend log on stdin — raw pino JSON or the pretty format `octi`
 * writes to ~/.octipus/backend.log:
 *   npx tsx scripts/decision-shadow.ts < ~/.octipus/backend.log
 *   npx tsx scripts/decision-shadow.ts < ~/.octipus/decision-shadow.jsonl
 *   docker logs octipus 2>&1 | npx tsx scripts/decision-shadow.ts
 *   journalctl -u octipus -o cat | npx tsx scripts/decision-shadow.ts
 *
 * Sites without an agreement field (relevance, page-state) report counts only.
 */
import { createInterface } from 'node:readline';

const sites = new Map<string, { n: number; agreed: number; compared: number; other: Record<string, number> }>();
const decisions = new Map<string, { n: number; confident: number; latency: number[] }>();

/** Yield each log record as an object: JSON lines as-is, pretty blocks (`[ts] INFO: msg` + indented `key: value`) rebuilt. */
async function* records(): AsyncGenerator<Record<string, unknown>> {
  let block: { msg: string; fields: Array<[string, string]> } | null = null;
  const flush = () => {
    if (!block) return null;
    const e: Record<string, unknown> = { msg: block.msg };
    for (const [k, v] of block.fields) { try { e[k] = JSON.parse(v); } catch { e[k] = v; } }
    block = null;
    return e;
  };
  for await (const raw of createInterface({ input: process.stdin })) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (line.startsWith('{')) { try { yield JSON.parse(line); } catch { /* not a record */ } continue; }
    const head = /^\[[^\]]+\] \w+: (.*)$/.exec(line);
    if (head) { const e = flush(); if (e) yield e; block = { msg: head[1], fields: [] }; continue; }
    if (!block) continue;
    const kv = /^ {4}(\w+): (.*)$/.exec(line);
    if (kv) block.fields.push([kv[1], kv[2]]);
    else if (block.fields.length) block.fields[block.fields.length - 1][1] += `\n${line}`;
  }
  const e = flush(); if (e) yield e;
}

for await (const e of records()) {
  if (typeof e.site !== 'string') continue;
  if ((e.kind === 'decision' || e.msg === 'Decision') && typeof e.confident === 'boolean') {
    const key = `${e.site} | ${typeof e.model === 'string' ? e.model : 'unknown model'}`;
    const d = decisions.get(key) ?? { n: 0, confident: 0, latency: [] };
    d.n++;
    if (e.confident) d.confident++;
    if (typeof e.latencyMs === 'number' && Number.isFinite(e.latencyMs)) d.latency.push(e.latencyMs);
    decisions.set(key, d);
    continue;
  }
  if (e.msg !== 'decision shadow' && e.kind !== 'shadow') continue;
  const s = sites.get(e.site) ?? { n: 0, agreed: 0, compared: 0, other: {} };
  s.n++;
  // email.triage batches carry compared/agreed counts; single-label sites a boolean.
  if (typeof e.compared === 'number') { s.compared += e.compared; s.agreed += Number(e.agreed) || 0; }
  else if (typeof e.agreed === 'boolean') { s.compared++; if (e.agreed) s.agreed++; }
  for (const k of ['wouldDrop', 'hits', 'priorityAgreed', 'categoryAgreed'] as const) if (typeof e[k] === 'number') s.other[k] = (s.other[k] ?? 0) + (e[k] as number);
  if (Array.isArray(e.wouldAdd)) for (const h of e.wouldAdd) s.other[String(h)] = (s.other[String(h)] ?? 0) + 1;
  sites.set(e.site, s);
}

if (sites.size === 0 && decisions.size === 0) console.log('No decision records. Is a model bound to the decision topic?');
for (const [key, d] of [...decisions].sort()) {
  const latencies = d.latency.sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? `${latencies[Math.ceil(latencies.length * p) - 1]} ms` : 'unknown';
  console.log(`${key}: ${(100 * d.confident / d.n).toFixed(1)}% confident (${d.confident}/${d.n}); p50 ${percentile(0.5)}, p95 ${percentile(0.95)}`);
}
if (decisions.size) console.log('Confidence coverage counts validated responses only; failures and privacy blocks are not in this denominator.');
if (sites.size) console.log('Agreement is grouped by site; historical shadow records have no model identity. Compare separate time windows for each model. Agreement is not labelled accuracy.');
for (const [site, s] of [...sites].sort()) {
  const agreement = s.compared ? `${((100 * s.agreed) / s.compared).toFixed(1)}% agreed (${s.agreed}/${s.compared})` : 'no comparisons';
  const extra = Object.keys(s.other).length ? `  ${JSON.stringify(s.other)}` : '';
  console.log(`${site.padEnd(26)} ${String(s.n).padStart(6)} lines  ${agreement}${extra}`);
}

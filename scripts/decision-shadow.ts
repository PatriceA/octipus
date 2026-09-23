/**
 * Decision-model shadow report — per call site, how often the decision model
 * agreed with the path that actually decided (docs/plans/decision-models.md).
 * This is the number that justifies flipping a site's *_LIVE constant.
 *
 * Reads the backend's JSON log lines (raw pino, not pretty) on stdin:
 *   docker logs octipus 2>&1 | npx tsx scripts/decision-shadow.ts
 *   journalctl -u octipus -o cat | npx tsx scripts/decision-shadow.ts
 *
 * Sites without an agreement field (relevance, page-state) report counts only.
 */
import { createInterface } from 'node:readline';

const sites = new Map<string, { n: number; agreed: number; compared: number; other: Record<string, number> }>();

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.includes('decision shadow')) continue;
  let e: Record<string, unknown>;
  try { e = JSON.parse(line.slice(line.indexOf('{'))); } catch { continue; }
  if (e.msg !== 'decision shadow' || typeof e.site !== 'string') continue;
  const s = sites.get(e.site) ?? { n: 0, agreed: 0, compared: 0, other: {} };
  s.n++;
  // email.triage batches carry compared/agreed counts; single-label sites a boolean.
  if (typeof e.compared === 'number') { s.compared += e.compared; s.agreed += Number(e.agreed) || 0; }
  else if (typeof e.agreed === 'boolean') { s.compared++; if (e.agreed) s.agreed++; }
  for (const k of ['wouldDrop', 'hits'] as const) if (typeof e[k] === 'number') s.other[k] = (s.other[k] ?? 0) + (e[k] as number);
  if (Array.isArray(e.wouldAdd)) for (const h of e.wouldAdd) s.other[String(h)] = (s.other[String(h)] ?? 0) + 1;
  sites.set(e.site, s);
}

if (sites.size === 0) console.log('No "decision shadow" lines. Is a model bound to the decision topic, and are logs raw JSON?');
for (const [site, s] of [...sites].sort()) {
  const agreement = s.compared ? `${((100 * s.agreed) / s.compared).toFixed(1)}% agreed (${s.agreed}/${s.compared})` : 'no comparisons';
  const extra = Object.keys(s.other).length ? `  ${JSON.stringify(s.other)}` : '';
  console.log(`${site.padEnd(26)} ${String(s.n).padStart(6)} lines  ${agreement}${extra}`);
}

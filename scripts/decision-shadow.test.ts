import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const report = (input: string) => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/decision-shadow.ts'], { input, encoding: 'utf8' });
describe('decision shadow report', () => {
  it('reads persistent JSONL and separates confidence coverage by model', () => {
    const input = [
      { kind: 'decision', site: 'test', model: 'jev', confident: true, latencyMs: 100 },
      { kind: 'decision', site: 'test', model: 'jev', confident: false, latencyMs: 300 },
      { kind: 'decision', site: 'test', model: 'clef', confident: true, latencyMs: 50 },
      { kind: 'shadow', site: 'test', agreed: false },
      { kind: 'shadow', site: 'test', compared: 3, agreed: 2 },
    ].map(x => JSON.stringify(x)).join('\n');
    const out = report(input);
    expect(out).toContain('test | jev: 50.0% confident (1/2); p50 100 ms, p95 300 ms');
    expect(out).toContain('test | clef: 100.0% confident (1/1)');
    expect(out).toContain('50.0% agreed (2/4)');
    expect(out).toContain('failures and privacy blocks are not in this denominator');
  });
  it('still reads raw pino and pretty logs', () => {
    expect(report(JSON.stringify({ msg: 'decision shadow', site: 'raw', agreed: true }))).toContain('100.0% agreed (1/1)');
    expect(report('[12:00:00] INFO: decision shadow\n    site: "pretty"\n    agreed: false\n')).toContain('0.0% agreed (0/1)');
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadSuiteFromFile, loadSuites } from './loader';

function suite(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'octipus-eval-'));
  const file = join(dir, 's.yaml');
  writeFileSync(file, `name: s\ntests:\n  - id: t\n    input: "x"\n    assertions:\n${body}`);
  return file;
}

describe('eval suite loader', () => {
  test('double-quoted values take YAML escapes, single-quoted only the doubled quote', async () => {
    const s = await loadSuiteFromFile(suite([
      '      - type: matches_regex',
      '        value: "\\\\d+\\\\.\\\\d+ \\"q\\" \\\\[x\\\\]"',
      "      - type: contains",
      "        value: 'it''s \\d'",
      '      - type: contains',
      '        value: "keep \\[ unknown"',
    ].join('\n')));
    const values = s.tests[0].assertions.map((a) => a.value);
    expect(values).toEqual(['\\d+\\.\\d+ "q" \\[x\\]', "it's \\d", 'keep \\[ unknown']);
  });

  test('every shipped suite loads; the interactive-answer marker regex matches a marker and nothing else', async () => {
    const suites = await loadSuites('eval');
    const iu = suites.find((s) => s.tests.some((t) => t.id === 'iu-pos-loan-calculator'));
    expect(iu).toBeDefined();
    const shown = new RegExp(String(iu!.tests[0].assertions[0].value));
    expect(shown.test('Here:\n[[octi-ui:11111111-1111-4111-8111-111111111111|Calc]]')).toBe(true);
    expect(shown.test('A plain answer with 12 in it.')).toBe(false);
    expect(iu!.tests.find((t) => t.id === 'iu-not-offered-without-renders')?.context).toBeUndefined();
    expect(iu!.tests[0].context).toEqual({ renders: ['inline_ui'] });
  });
});

/** Module text in prompts (docs/MODULES.md): gone while the module is off, the markers always. */
import { describe, expect, test } from 'vitest';
import { withoutOffModules } from './prompt';

const on = (ids: string[]) => (id: string) => ids.includes(id);

describe('withoutOffModules', () => {
  const prompt = [
    'Tools:',
    '- `notes` — notes.',
    '- `artifacts` — live dashboards. <!-- module:artifacts -->',
    '<!-- module:voice -->',
    '## Calls',
    'Call with `voice__initiate_call`.',
    '<!-- /module -->',
    'Done.',
  ].join('\n');

  test('off: the marked line and the marked block are left out', () => {
    expect(withoutOffModules(prompt, on([]))).toBe('Tools:\n- `notes` — notes.\nDone.');
  });

  test('on: the text stays, without its markers', () => {
    expect(withoutOffModules(prompt, on(['artifacts', 'voice']))).toBe('Tools:\n- `notes` — notes.\n- `artifacts` — live dashboards.\n## Calls\nCall with `voice__initiate_call`.\nDone.');
  });

  test('`module:!id` is the text used instead while the module is off', () => {
    const alt = 'You build dashboards. <!-- module:artifacts -->\nYou design schemas. <!-- module:!artifacts -->\n<!-- module:!artifacts -->\nNo dashboards here.\n<!-- /module -->';
    expect(withoutOffModules(alt, on(['artifacts']))).toBe('You build dashboards.');
    expect(withoutOffModules(alt, on([]))).toBe('You design schemas.\nNo dashboards here.');
  });

  test('a block inside an off block stays out; an unmarked prompt is returned as is', () => {
    const nested = '<!-- module:a -->\nA\n<!-- module:b -->\nB\n<!-- /module -->\nA2\n<!-- /module -->\nend';
    expect(withoutOffModules(nested, on(['b']))).toBe('end');
    expect(withoutOffModules(nested, on(['a']))).toBe('A\nA2\nend');
    expect(withoutOffModules('plain <!-- a comment --> text', on([]))).toBe('plain <!-- a comment --> text');
  });
});

describe('the prompt files', () => {
  test('every module block is closed, and every marker names a module', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { MODULES } = await import('@/modules');
    const ids = new Set(MODULES.map((m) => m.id));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.md') ? [path] : [];
    });
    for (const file of files(join(process.cwd(), 'src/core/agent'))) {
      let depth = 0;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        for (const [, id] of line.matchAll(/<!--\s*module:!?([a-z0-9-]+)\s*-->/g)) expect(ids.has(id), `${file}: ${id}`).toBe(true);
        if (/^\s*<!--\s*module:!?[a-z0-9-]+\s*-->\s*$/.test(line)) depth++;
        if (/^\s*<!--\s*\/module\s*-->\s*$/.test(line)) depth--;
        expect(depth, file).toBeGreaterThanOrEqual(0);
      }
      expect(depth, `${file}: a module block is not closed`).toBe(0);
    }
  });
});

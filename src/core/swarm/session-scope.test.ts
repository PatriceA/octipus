import { afterEach, describe, expect, test } from 'bun:test';
import { buildSiblingScopeBrief, clearSessionScope, recordChildScope } from './session-scope';

const SESSION = 'session-scope-test';

afterEach(() => clearSessionScope(SESSION));

describe('sibling session scope', () => {
  test('is empty until a child records work and ignores empty session ids', () => {
    recordChildScope('', {
      nodeId: 'ignored', role: 'coding', topicPath: 'root/coding', paths: ['src/ignored.ts'], report: 'ignored',
    });
    expect(buildSiblingScopeBrief(SESSION, { topicPath: 'root/coding' })).toBe('');
  });

  test('warns later children about changed files without duplicate paths', () => {
    recordChildScope(SESSION, {
      nodeId: 'coding-1', role: 'coding', topicPath: 'root/coding/api',
      paths: ['src/api.ts', 'src/api.ts', ''], report: '',
    });

    const brief = buildSiblingScopeBrief(SESSION, { topicPath: 'root/qa' });
    expect(brief).toContain('FILES ALREADY CHANGED THIS SESSION');
    expect(brief).toContain('- src/api.ts (by coding)');
    expect(brief.match(/src\/api\.ts/g)).toHaveLength(1);
  });

  test('includes reports only for overlapping mandates and excludes the caller', () => {
    recordChildScope(SESSION, {
      nodeId: 'coding-1', role: 'coding', topicPath: 'root/coding/api', paths: [], report: 'Implemented endpoint.',
    });
    recordChildScope(SESSION, {
      nodeId: 'research-1', role: 'research', topicPath: 'root/research/web', paths: [], report: 'Unrelated report.',
    });

    const overlapping = buildSiblingScopeBrief(SESSION, { topicPath: 'root/coding/tests' });
    expect(overlapping).toContain('RELATED SIBLING WORK');
    expect(overlapping).toContain('Implemented endpoint.');
    expect(overlapping).not.toContain('Unrelated report.');

    const excluded = buildSiblingScopeBrief(SESSION, { topicPath: 'root/coding/tests', excludeNodeId: 'coding-1' });
    expect(excluded).toBe('');
  });

  test('truncates oversized reports and limits the changed-file listing', () => {
    recordChildScope(SESSION, {
      nodeId: 'coding-1', role: 'coding', topicPath: 'root/coding',
      paths: Array.from({ length: 41 }, (_, i) => `src/file-${i}.ts`),
      report: 'x'.repeat(1_501),
    });

    const brief = buildSiblingScopeBrief(SESSION, { topicPath: 'root/coding' });
    expect(brief).toContain('…and 1 more');
    expect(brief).toContain('…');
    expect(brief).not.toContain('src/file-40.ts (by coding)');
  });

  test('clears all recorded state for a session', () => {
    recordChildScope(SESSION, {
      nodeId: 'coding-1', role: 'coding', topicPath: 'root/coding', paths: ['src/app.ts'], report: 'done',
    });
    clearSessionScope(SESSION);
    expect(buildSiblingScopeBrief(SESSION, { topicPath: 'root/coding' })).toBe('');
  });
});

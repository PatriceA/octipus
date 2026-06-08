/**
 * eval result path containment.
 *
 * `GET /eval/results/:id` reads `<cwd>/eval/results/<id>.json`. The id is
 * user-supplied, so it must stay strictly inside EVAL_RESULTS_DIR. The old
 * guard used a bare `startsWith(EVAL_RESULTS_DIR)`, which also accepted
 * sibling dirs sharing the prefix (`…/results-evil/x.json`). These lock the
 * path-segment check that replaced it.
 */
import { describe, expect, test } from 'bun:test';
import { resolve, sep } from 'node:path';
import { resolveEvalResultPath } from './eval';

const ROOT = resolve(process.cwd(), 'eval', 'results');

describe('resolveEvalResultPath', () => {
  test('a plain id resolves to <results>/<id>.json', () => {
    expect(resolveEvalResultPath('run-123')).toBe(resolve(ROOT, 'run-123.json'));
  });

  test('an id already ending in .json is not double-suffixed', () => {
    expect(resolveEvalResultPath('run-123.json')).toBe(resolve(ROOT, 'run-123.json'));
  });

  test('parent traversal is rejected', () => {
    expect(resolveEvalResultPath('../../etc/passwd')).toBeNull();
  });

  test('sibling-prefix escape is rejected (the startsWith bug)', () => {
    // resolves to `<…>/eval/results-evil/x.json`, which the old
    // `startsWith(ROOT)` check let through.
    expect(resolveEvalResultPath('../results-evil/x')).toBeNull();
  });

  test('any accepted path is strictly under the results dir', () => {
    const p = resolveEvalResultPath('nested/run');
    expect(p).not.toBeNull();
    expect((p as string).startsWith(ROOT + sep)).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';
import { sessionCountOf } from './skill-proposals';

describe('sessionCountOf', () => {
  test('counts distinct sessions across learning and distill refs', () => {
    expect(sessionCountOf([])).toBe(0);
    expect(sessionCountOf(['learning:j1:session:s1', 'learning:j2:session:s1', 'session:s1'])).toBe(1);
    expect(sessionCountOf(['learning:j1:session:s1', 'learning:j2:session:s2'])).toBe(2);
  });

  test('other refs each count as one distinct source', () => {
    expect(sessionCountOf(['text', 'trajectory:t1', 'trajectory:t2', 'session:s1'])).toBe(4);
    expect(sessionCountOf(['trajectory:t1', 'trajectory:t1'])).toBe(1);
  });

  test('a session id that contains colons is kept whole', () => {
    expect(sessionCountOf(['learning:j1:session:a:b', 'session:a:b', 'session:a'])).toBe(2);
  });
});

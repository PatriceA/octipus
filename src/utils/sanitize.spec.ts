import { describe, test, expect } from 'bun:test';
import { sanitizeToolOutput } from '@/utils/sanitize';

describe('sanitizeToolOutput', () => {
  test('converts objects to JSON', () => {
    const result = sanitizeToolOutput({ key: 'value' });
    expect(result).toBe('{"key":"value"}');
  });
});

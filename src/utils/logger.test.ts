import { expect, test } from 'vitest';
import { defaultLogFormat } from './logger';

test('pretty on a terminal, JSON lines otherwise, and LOG_FORMAT always wins', () => {
  expect(defaultLogFormat({}, true)).toBe('pretty');
  expect(defaultLogFormat({}, false)).toBe('json');
  expect(defaultLogFormat({}, undefined)).toBe('json');
  expect(defaultLogFormat({ LOG_FORMAT: 'pretty' }, false)).toBe('pretty');
  expect(defaultLogFormat({ LOG_FORMAT: 'json' }, true)).toBe('json');
});

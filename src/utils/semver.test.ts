import { expect, test } from 'vitest';
import { compareVersions } from './semver';

test('compareVersions orders by number, a pre-release before its release', () => {
  const sorted = ['1.10.0', '1.2.0', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0-alpha', '0.9.9'].sort(compareVersions);
  expect(sorted).toEqual(['0.9.9', '1.2.0-alpha', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0', '1.10.0']);
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
});

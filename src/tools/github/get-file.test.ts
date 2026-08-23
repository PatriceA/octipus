import { describe, expect, test } from 'vitest';
import { buildContentsEndpoint, isAllowedGitHubHost } from './index';

describe('buildContentsEndpoint', () => {
  test('builds a normal contents endpoint', () => {
    expect(buildContentsEndpoint('PatriceA/octipus', 'DESIGN.md')).toBe('repos/PatriceA/octipus/contents/DESIGN.md');
  });

  test('encodes path segments and appends ref', () => {
    expect(buildContentsEndpoint('a/b', 'src/core/index.ts', 'feat/x')).toBe(
      'repos/a/b/contents/src/core/index.ts?ref=feat%2Fx',
    );
    expect(buildContentsEndpoint('a/b', 'a folder/f.md')).toBe('repos/a/b/contents/a%20folder/f.md');
  });

  test('strips leading slashes', () => {
    expect(buildContentsEndpoint('a/b', '/README.md')).toBe('repos/a/b/contents/README.md');
  });

  test('rejects path traversal segments', () => {
    expect(() => buildContentsEndpoint('a/b', '../../users')).toThrow(/Invalid file path/);
    expect(() => buildContentsEndpoint('a/b', 'src/../../../etc')).toThrow(/Invalid file path/);
    expect(() => buildContentsEndpoint('a/b', 'a/./b')).toThrow(/Invalid file path/);
  });

  test('rejects a repo that is not owner/name', () => {
    expect(() => buildContentsEndpoint('not-a-repo', 'x.md')).toThrow(/Invalid repo/);
    expect(() => buildContentsEndpoint('a/b/c', 'x.md')).toThrow(/Invalid repo/);
    expect(() => buildContentsEndpoint('../../x/y', 'x.md')).toThrow(/Invalid repo/);
  });
});

describe('isAllowedGitHubHost', () => {
  test('accepts GitHub-owned hosts', () => {
    expect(isAllowedGitHubHost('https://raw.githubusercontent.com/a/b/main/f')).toBe(true);
    expect(isAllowedGitHubHost('https://api.github.com/repos/a/b/contents/f')).toBe(true);
    expect(isAllowedGitHubHost('https://github.com/a/b')).toBe(true);
  });

  test('rejects non-GitHub and malformed hosts', () => {
    expect(isAllowedGitHubHost('https://evil.example/x')).toBe(false);
    expect(isAllowedGitHubHost('https://raw.githubusercontent.com.evil.example/x')).toBe(false);
    expect(isAllowedGitHubHost('not a url')).toBe(false);
  });
});

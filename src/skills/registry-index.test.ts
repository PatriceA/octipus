/**
 * The skill registry index (docs/SKILL-EXCHANGE.md#the-index) as hostile
 * input: size, version, strict entries, URLs that cannot point inside the
 * network, text that cannot render as anything but text.
 */
import { describe, expect, test } from 'vitest';
import { bundleUrlProblem, MAX_SKILL_INDEX_BYTES, MAX_SKILL_INDEX_ENTRIES, parseSkillIndex } from './registry-index';

const HASH = `sha256:${'a'.repeat(64)}`;
const entry = (over: Record<string, unknown> = {}) => ({
  name: 'release-notes', version: '1.0.0', description: 'Write release notes', tags: ['writing'], author: 'Acme',
  publisherKeyId: `ed25519:${'b'.repeat(64)}`, skills: ['Release notes'],
  bundleUrl: 'https://skills.example.com/release-notes-1.0.0.json', bundleSha256: HASH, contentHash: HASH, ...over,
});
const doc = (entries: unknown[], over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ format: 'octipus-skill-index', version: 1, generatedAt: '2026-11-23T10:00:00Z', entries, ...over }));

describe('parseSkillIndex', () => {
  test('reads a valid index', () => {
    const parsed = parseSkillIndex(doc([entry(), entry({ version: '1.1.0' })]));
    expect(parsed.problems).toEqual([]);
    expect(parsed.entries.map((e) => e.version)).toEqual(['1.0.0', '1.1.0']);
  });

  test('refuses an oversized document, a newer version, the wrong format, too many entries and broken JSON outright', () => {
    expect(() => parseSkillIndex(Buffer.alloc(MAX_SKILL_INDEX_BYTES + 1, 0x20))).toThrow(/at most 1048576 are read/);
    expect(() => parseSkillIndex(doc([], { version: 2 }))).toThrow(/newer than this Octipus reads/);
    expect(() => parseSkillIndex(doc([], { format: 'octipus-plugin-index' }))).toThrow(/not a skill index/);
    expect(() => parseSkillIndex(doc(new Array(MAX_SKILL_INDEX_ENTRIES + 1).fill(0)))).toThrow(/at most 2000 entries/);
    expect(() => parseSkillIndex(Buffer.from('{'))).toThrow(/not valid JSON/);
    expect(() => parseSkillIndex(doc([], { extra: true }))).toThrow(/Not a valid skill index/);
  });

  test('skips (and reports) a bad entry without hiding the rest', () => {
    const parsed = parseSkillIndex(doc([
      entry(),
      entry({ name: 'Bad Name' }),
      entry({ name: 'http', bundleUrl: 'http://skills.example.com/x.json' }),
      entry({ name: 'private', bundleUrl: 'https://192.168.1.10/x.json' }),
      entry({ name: 'loopback', bundleUrl: 'https://127.0.0.1/x.json' }),
      entry({ name: 'local', bundleUrl: 'https://intranet.localhost/x.json' }),
      entry({ name: 'creds', bundleUrl: 'https://user:pw@skills.example.com/x.json' }),
      entry({ name: 'html', description: 'line‮one' }),
      entry({ name: 'control', description: 'a\u0007b' }),
      entry({ name: 'digest', bundleSha256: 'abc' }),
      entry({ name: 'key', publisherKeyId: 'ed25519:short' }),
      entry({ name: 'twice', skills: ['A', 'a'] }),
      entry({ name: 'extra', isSystem: true }),
      entry({ name: 'version', version: 'latest' }),
    ]));
    expect(parsed.entries.map((e) => e.name)).toEqual(['release-notes']);
    expect(parsed.problems).toHaveLength(13);
    expect(parsed.problems.join('\n')).toMatch(/private or reserved address \(192\.168\.1\.10\)/);
    expect(parsed.problems.join('\n')).toMatch(/only https/);
  });

  test('a name and version listed twice: neither is listed', () => {
    const parsed = parseSkillIndex(doc([entry(), entry({ bundleSha256: `sha256:${'c'.repeat(64)}` }), entry({ version: '2.0.0' })]));
    expect(parsed.entries.map((e) => e.version)).toEqual(['2.0.0']);
    expect(parsed.problems).toEqual(['release-notes 1.0.0: listed more than once; neither is listed']);
  });
});

describe('versions', () => {
  test('SemVer 2.0 only, so the newest never depends on index order', () => {
    const versions = ['1.0.0', '0.0.1', '1.0.0-0.3.7', '1.0.0-x-y.1', '1.0.0-rc.1', '999999.0.0'];
    expect(parseSkillIndex(doc(versions.map((version) => entry({ version })))).entries).toHaveLength(versions.length);
    for (const version of ['01.0.0', '1.00.0', '1.0.0-', '1.0.0-a..b', '1.0.0-01', '1.0.0+build', '1234567.0.0', '1.0.0-1234567890', `1.0.0-${'a'.repeat(65)}`, '1.0', 'v1.0.0']) {
      expect(parseSkillIndex(doc([entry({ version })])).entries, version).toEqual([]);
    }
  });
});

describe('bundleUrlProblem', () => {
  test('https on a public host only', () => {
    expect(bundleUrlProblem('https://raw.example.org/a/b.json')).toBeNull();
    for (const url of ['https://localhost/x', 'https://[::1]/x', 'https://169.254.169.254/x', 'https://2130706433/x', 'https://0x7f.0.0.1/x', 'ftp://example.com/x', 'https://example.com/x#frag', 'not a url']) {
      expect(bundleUrlProblem(url), url).not.toBeNull();
    }
  });
});

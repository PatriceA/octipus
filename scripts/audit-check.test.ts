import { describe, expect, test } from 'vitest';
import {
  evaluateAdvisories,
  isExpired,
  parseAuditOutput,
  type Advisory,
  type AllowlistEntry,
} from './audit-check';

const NOW = new Date('2026-07-11T12:00:00Z');

const formData: Advisory = {
  id: '1120743',
  ghsa: 'GHSA-hmw2-7cc7-3qxx',
  severity: 'high',
  title: 'CRLF injection in form-data',
  package: 'form-data',
  url: 'https://github.com/advisories/GHSA-hmw2-7cc7-3qxx',
};

describe('isExpired', () => {
  test('future expiry is not expired', () => {
    expect(isExpired({ id: 'x', reason: 'r', expires: '2026-09-01' }, NOW)).toBe(false);
  });

  test('the expiry date itself is still valid', () => {
    expect(isExpired({ id: 'x', reason: 'r', expires: '2026-07-11' }, NOW)).toBe(false);
  });

  test('past expiry is expired', () => {
    expect(isExpired({ id: 'x', reason: 'r', expires: '2026-07-10' }, NOW)).toBe(true);
  });

  test('missing expiry counts as expired', () => {
    expect(isExpired({ id: 'x', reason: 'r' } as AllowlistEntry, NOW)).toBe(true);
  });

  test('unparseable expiry counts as expired', () => {
    expect(isExpired({ id: 'x', reason: 'r', expires: 'soon' }, NOW)).toBe(true);
  });
});

describe('evaluateAdvisories — matching', () => {
  test('un-allowlisted advisory blocks', () => {
    const r = evaluateAdvisories([formData], [], NOW);
    expect(r.blocking).toHaveLength(1);
    expect(r.allowlisted).toHaveLength(0);
    expect(r.shouldFail).toBe(true);
  });

  test('allowlist by GHSA tolerates the advisory', () => {
    const allow: AllowlistEntry[] = [
      { id: 'GHSA-hmw2-7cc7-3qxx', reason: 'not reachable', expires: '2026-09-01' },
    ];
    const r = evaluateAdvisories([formData], allow, NOW);
    expect(r.blocking).toHaveLength(0);
    expect(r.allowlisted).toHaveLength(1);
    expect(r.allowlisted[0].entry.reason).toBe('not reachable');
    expect(r.shouldFail).toBe(false);
  });

  test('allowlist by numeric id tolerates the advisory', () => {
    const allow: AllowlistEntry[] = [
      { id: '1120743', reason: 'accepted', expires: '2026-09-01' },
    ];
    const r = evaluateAdvisories([formData], allow, NOW);
    expect(r.allowlisted).toHaveLength(1);
    expect(r.shouldFail).toBe(false);
  });

  test('GHSA matching is case-insensitive', () => {
    const allow: AllowlistEntry[] = [
      { id: 'ghsa-hmw2-7cc7-3qxx', reason: 'accepted', expires: '2026-09-01' },
    ];
    const r = evaluateAdvisories([formData], allow, NOW);
    expect(r.allowlisted).toHaveLength(1);
  });

  test('matches GHSA derived from url when advisory has no ghsa field', () => {
    const advisory: Advisory = {
      id: '999',
      package: 'foo',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
    };
    const allow: AllowlistEntry[] = [
      { id: 'GHSA-aaaa-bbbb-cccc', reason: 'ok', expires: '2026-09-01' },
    ];
    const r = evaluateAdvisories([advisory], allow, NOW);
    expect(r.allowlisted).toHaveLength(1);
  });

  test('non-matching allowlist entry does not tolerate', () => {
    const allow: AllowlistEntry[] = [
      { id: 'GHSA-zzzz-zzzz-zzzz', reason: 'other', expires: '2026-09-01' },
    ];
    const r = evaluateAdvisories([formData], allow, NOW);
    expect(r.blocking).toHaveLength(1);
    // The non-matching entry is also expired-checked; it is valid here, so it
    // is not an expired entry, but it still fails because the advisory blocks.
    expect(r.shouldFail).toBe(true);
  });
});

describe('evaluateAdvisories — expiry', () => {
  test('expired entry does not tolerate its advisory and fails', () => {
    const allow: AllowlistEntry[] = [
      { id: 'GHSA-hmw2-7cc7-3qxx', reason: 'stale', expires: '2026-07-01' },
    ];
    const r = evaluateAdvisories([formData], allow, NOW);
    expect(r.blocking).toHaveLength(1);
    expect(r.expiredEntries).toHaveLength(1);
    expect(r.shouldFail).toBe(true);
  });

  test('expired entry fails even when no advisory currently matches it', () => {
    const allow: AllowlistEntry[] = [
      { id: 'GHSA-old0-old0-old0', reason: 'stale', expires: '2020-01-01' },
    ];
    const r = evaluateAdvisories([], allow, NOW);
    expect(r.blocking).toHaveLength(0);
    expect(r.expiredEntries).toHaveLength(1);
    expect(r.shouldFail).toBe(true);
  });

  test('clean tree with valid allowlist passes', () => {
    const allow: AllowlistEntry[] = [
      { id: 'GHSA-hmw2-7cc7-3qxx', reason: 'ok', expires: '2026-09-01' },
    ];
    const r = evaluateAdvisories([], allow, NOW);
    expect(r.shouldFail).toBe(false);
  });

  test('no advisories and empty allowlist passes', () => {
    const r = evaluateAdvisories([], [], NOW);
    expect(r.shouldFail).toBe(false);
  });
});

describe('parseAuditOutput', () => {
  test("npm's own report shape (auditReportVersion 2) is understood", () => {
    // The runner is `npm audit --omit=dev --json` since Bun left the repo. Its
    // shape is a map under `vulnerabilities`, not the `advisories` bun emitted,
    // and the generic map walk would otherwise read `metadata` as a package.
    const npmReport = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        'left-pad': {
          name: 'left-pad',
          severity: 'high',
          via: [
            {
              source: 1234,
              name: 'left-pad',
              title: 'Prototype pollution in left-pad',
              url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
              severity: 'high',
            },
          ],
        },
      },
      metadata: { vulnerabilities: { total: 1 }, dependencies: { total: 42 } },
    });
    const found = parseAuditOutput(npmReport);
    expect(found).toHaveLength(1);
    expect(found[0].package).toBe('left-pad');
    expect(found[0].severity).toBe('high');
    expect(found[0].ghsa).toBe('GHSA-aaaa-bbbb-cccc');
    expect(found[0].title).toContain('Prototype pollution');
  });

  test('a clean npm report is no advisories, not a parse of its metadata', () => {
    const clean = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { total: 0 }, dependencies: { total: 600 } },
    });
    expect(parseAuditOutput(clean)).toEqual([]);
  });

  test('empty / clean outputs yield no advisories', () => {
    expect(parseAuditOutput('')).toEqual([]);
    expect(parseAuditOutput('{}')).toEqual([]);
    expect(parseAuditOutput('[]')).toEqual([]);
    expect(parseAuditOutput('null')).toEqual([]);
  });

  test('parses the observed bun shape { pkg: Advisory[] }', () => {
    const raw = JSON.stringify({
      'form-data': [
        {
          id: 1120743,
          url: 'https://github.com/advisories/GHSA-hmw2-7cc7-3qxx',
          title: 'CRLF injection',
          severity: 'high',
        },
      ],
    });
    const out = parseAuditOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0].package).toBe('form-data');
    expect(out[0].id).toBe('1120743');
    expect(out[0].ghsa).toBe('GHSA-hmw2-7cc7-3qxx');
    expect(out[0].severity).toBe('high');
  });

  test('parses { advisories: {...} } wrapper shape', () => {
    const raw = JSON.stringify({
      advisories: {
        lodash: [{ id: 42, severity: 'low', title: 't', url: 'https://x/GHSA-aaaa-bbbb-cccc' }],
      },
    });
    const out = parseAuditOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0].package).toBe('lodash');
    expect(out[0].ghsa).toBe('GHSA-aaaa-bbbb-cccc');
  });

  test('parses a bare array of advisories', () => {
    const raw = JSON.stringify([
      { id: 'GHSA-aaaa-bbbb-cccc', module_name: 'foo', severity: 'moderate' },
    ]);
    const out = parseAuditOutput(raw);
    expect(out).toHaveLength(1);
    expect(out[0].package).toBe('foo');
    expect(out[0].ghsa).toBe('GHSA-aaaa-bbbb-cccc');
  });

  test('throws on unparseable non-empty output', () => {
    expect(() => parseAuditOutput('not json at all')).toThrow();
  });

  test('end-to-end: parsed real-shape advisory blocks without allowlist', () => {
    const raw = JSON.stringify({
      'form-data': [
        {
          id: 1120743,
          url: 'https://github.com/advisories/GHSA-hmw2-7cc7-3qxx',
          severity: 'high',
        },
      ],
    });
    const r = evaluateAdvisories(parseAuditOutput(raw), [], NOW);
    expect(r.shouldFail).toBe(true);
    expect(r.blocking[0].package).toBe('form-data');
  });
});

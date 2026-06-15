import { describe, expect, test } from 'bun:test';
import { summarizeWebhookPayload } from './webhook-summary';

describe('summarizeWebhookPayload', () => {
  test('summarizes a GitHub push to repo/branch/commits/files without dumping metadata', () => {
    const payload = {
      ref: 'refs/heads/claude/small-model',
      compare: 'https://github.com/PatriceA/octipus/compare/b52150e22c3c...3b6cf80a9ab2',
      repository: { full_name: 'PatriceA/octipus', name: 'octipus', owner: { avatar_url: 'https://avatars.example/x' } },
      pusher: { name: 'PatriceA' },
      commits: [
        {
          id: '3b6cf80a9ab2a5a11c34dacadc14556fe5467df8',
          message: 'fix(small-model): address code-review findings\n\nlong body...',
          added: [],
          modified: ['src/core/orchestrator/small-model.ts', 'src/models/capability-gate.ts'],
          removed: [],
        },
      ],
    };
    const out = summarizeWebhookPayload(payload);

    expect(out).toContain('PatriceA/octipus');
    expect(out).toContain('claude/small-model');
    expect(out).toContain('PatriceA');
    expect(out).toContain('1 commit'); // singular
    expect(out).toContain('3b6cf80a9'); // short sha
    expect(out).toContain('fix(small-model): address code-review findings');
    expect(out).toContain('~src/core/orchestrator/small-model.ts');
    // The noisy metadata must NOT leak into the visible message.
    expect(out).not.toContain('avatar_url');
    expect(out).not.toContain('long body'); // only the commit subject, not the whole body
    expect(out.length).toBeLessThan(600);
  });

  test('caps a large push and notes the overflow', () => {
    const commits = Array.from({ length: 25 }, (_, i) => ({ id: `sha${i}`, message: `commit ${i}` }));
    const out = summarizeWebhookPayload({ ref: 'refs/heads/main', repository: { full_name: 'a/b' }, commits });
    expect(out).toContain('25 commits');
    expect(out).toContain('and 5 more commits');
  });

  test('falls back to a one-line field list for unknown payloads (no JSON dump)', () => {
    const out = summarizeWebhookPayload({ some: 'thing', nested: { a: 1 } });
    expect(out).toContain('fields:');
    expect(out).not.toContain('{');
  });

  test('handles a non-object payload safely', () => {
    expect(summarizeWebhookPayload(null)).toContain('no structured payload');
    expect(summarizeWebhookPayload('hello')).toContain('no structured payload');
  });
});

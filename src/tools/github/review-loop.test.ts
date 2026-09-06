/**
 * The review-loop functions of the GitHub tool, with `gh` mocked: what
 * matters is the exact argv each function hands to the CLI and how it reads
 * the answer back, not GitHub itself.
 */
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import type { ToolHandler } from '@/core/agent-worker';

const runGh = vi.fn<(args: string[], opts?: { acceptExitCodes?: number[] }) => Promise<string>>();
vi.mock('@/utils/gh', () => ({ runGh: (args: string[], opts?: { acceptExitCodes?: number[] }) => runGh(args, opts) }));

process.env.LOG_LEVEL ??= 'error';

let handlers: Map<string, ToolHandler>;
const ctx = { id: 'a', sessionId: 's', userId: 'u', role: 'general', topic: 'coding', model: 'm', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} } as AgentContext;
const call = (name: string, args: Record<string, unknown>) => handlers.get(name)!.execute(args, ctx) as Promise<any>;

beforeAll(async () => {
  const { GitHubTool } = await import('./index');
  const tool = new GitHubTool();
  await tool.initialize();
  handlers = (tool as unknown as { tools: Map<string, ToolHandler> }).tools;
});

beforeEach(() => runGh.mockReset());

describe('pure helpers', () => {
  test('tailLines keeps the end of a log and says how much it dropped', async () => {
    const { tailLines } = await import('./index');
    const t = tailLines('a\r\nb\nc\nd\n', 2);
    expect(t).toEqual({ log: 'c\nd', totalLines: 4, truncated: true });
    expect(tailLines('x\ny', 5)).toEqual({ log: 'x\ny', totalLines: 2, truncated: false });
  });

  test('summarizeReviewThreads flattens GraphQL and hides resolved threads by default', async () => {
    const { summarizeReviewThreads } = await import('./index');
    const response = {
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { id: 'T1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 12, startLine: null, diffSide: 'RIGHT',
          comments: { nodes: [{ databaseId: 5, author: { login: 'ada' }, body: 'rename this', createdAt: '2026-09-06T00:00:00Z', url: 'https://x/5' }] } },
        { id: 'T2', isResolved: true, isOutdated: true, path: 'src/b.ts', line: 3, comments: { nodes: [] } },
      ] } } } },
    };
    expect(summarizeReviewThreads(response)).toEqual([
      { id: 'T1', path: 'src/a.ts', line: 12, startLine: null, side: 'RIGHT', resolved: false, outdated: false,
        comments: [{ id: 5, author: 'ada', body: 'rename this', createdAt: '2026-09-06T00:00:00Z', url: 'https://x/5' }] },
    ]);
    expect(summarizeReviewThreads(response, { includeResolved: true })).toHaveLength(2);
    expect(summarizeReviewThreads({})).toEqual([]);
  });

  test('assertNumber and assertRepoRef reject what gh would misread', async () => {
    const { assertNumber, assertRepoRef } = await import('./index');
    expect(assertNumber(12, 'n')).toBe('12');
    expect(assertNumber('7', 'n')).toBe('7');
    expect(() => assertNumber('7; rm', 'n')).toThrow(/Invalid n/);
    expect(() => assertNumber(-1, 'n')).toThrow();
    expect(() => assertRepoRef('a/b/c')).toThrow(/Invalid repo/);
    expect(() => assertRepoRef('../x/y')).toThrow(/Invalid repo/);
  });
});

describe('review threads and comments', () => {
  test('pr_review_threads queries GraphQL with the repo split into owner and name', async () => {
    runGh.mockResolvedValueOnce(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { id: 'T1', isResolved: false, isOutdated: false, path: 'f.ts', line: 1, comments: { nodes: [{ databaseId: 9, author: { login: 'bob' }, body: 'why?' }] } },
    ] } } } } }));
    const r = await call('pr_review_threads', { repo: 'acme/app', number: 42 });
    const args = runGh.mock.calls[0][0];
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toEqual(expect.arrayContaining(['-F', 'owner=acme', '-F', 'name=app', '-F', 'number=42']));
    expect(r.count).toBe(1);
    expect(r.threads[0].comments[0]).toMatchObject({ id: 9, author: 'bob', body: 'why?' });
  });

  test('a new line comment resolves the head commit first, then posts with path/line/side', async () => {
    runGh.mockResolvedValueOnce(JSON.stringify({ headRefOid: 'abc123' }));
    runGh.mockResolvedValueOnce(JSON.stringify({ id: 77, html_url: 'https://github.com/acme/app/pull/42#discussion_r77' }));
    const r = await call('pr_review_comment', { repo: 'acme/app', number: 42, body: 'nit: rename', path: '/src/a.ts', line: 12 });
    expect(runGh.mock.calls[0][0]).toEqual(['pr', 'view', '42', '-R', 'acme/app', '--json', 'headRefOid']);
    expect(runGh.mock.calls[1][0]).toEqual([
      'api', 'repos/acme/app/pulls/42/comments',
      '-f', 'body=nit: rename', '-f', 'path=src/a.ts', '-F', 'line=12', '-f', 'side=RIGHT', '-f', 'commit_id=abc123',
    ]);
    expect(r).toEqual({ created: true, id: 77, url: 'https://github.com/acme/app/pull/42#discussion_r77' });
  });

  test('a reply goes to the thread comment, without touching the head commit', async () => {
    runGh.mockResolvedValueOnce(JSON.stringify({ id: 78 }));
    const r = await call('pr_review_comment', { repo: 'acme/app', number: 42, body: 'done in 3f2a', reply_to: 9 });
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(runGh.mock.calls[0][0]).toEqual(['api', 'repos/acme/app/pulls/42/comments/9/replies', '-f', 'body=done in 3f2a']);
    expect(r).toEqual({ replied: true, id: 78, url: null });
  });

  test('a new comment without a path, or on a bad repo, is refused before gh runs', async () => {
    await expect(call('pr_review_comment', { repo: 'acme/app', number: 42, body: 'x' })).rejects.toThrow(/needs a path/);
    await expect(call('pr_review_comment', { repo: 'acme/app/x', number: 42, body: 'x', path: 'f', line: 1 })).rejects.toThrow(/Invalid repo/);
    expect(runGh).not.toHaveBeenCalled();
  });

  test('pr_resolve_thread runs the resolve or unresolve mutation', async () => {
    runGh.mockResolvedValueOnce(JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'T1', isResolved: true } } } }));
    expect(await call('pr_resolve_thread', { thread_id: 'T1' })).toEqual({ threadId: 'T1', resolved: true });
    expect(runGh.mock.calls[0][0][3]).toContain('resolveReviewThread');
    runGh.mockResolvedValueOnce(JSON.stringify({ data: { unresolveReviewThread: { thread: { id: 'T1', isResolved: false } } } }));
    expect(await call('pr_resolve_thread', { thread_id: 'T1', resolve: false })).toEqual({ threadId: 'T1', resolved: false });
    expect(runGh.mock.calls[1][0][3]).toContain('unresolveReviewThread');
    await expect(call('pr_resolve_thread', { thread_id: 'T1 $(x)' })).rejects.toThrow(/Invalid thread_id/);
  });
});

describe('diff, checks and logs', () => {
  test('pr_diff returns the unified diff, or only the file list', async () => {
    runGh.mockResolvedValueOnce('diff --git a/x b/x\n+1\n');
    expect(await call('pr_diff', { repo: 'acme/app', number: 3 })).toEqual({ diff: 'diff --git a/x b/x\n+1', truncated: false });
    expect(runGh.mock.calls[0][0]).toEqual(['pr', 'diff', '3', '-R', 'acme/app']);
    runGh.mockResolvedValueOnce('src/a.ts\nsrc/b.ts\n');
    expect(await call('pr_diff', { repo: 'acme/app', number: 3, files_only: true })).toEqual({ files: ['src/a.ts', 'src/b.ts'] });
    expect(runGh.mock.calls[1][0]).toContain('--name-only');
  });

  test('pr_checks tolerates the failing/pending exit codes and counts buckets', async () => {
    runGh.mockResolvedValueOnce(JSON.stringify([{ name: 'test', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }, { name: 'e2e', bucket: 'pending' }]));
    const r = await call('pr_checks', { repo: 'acme/app', number: 3 });
    expect(runGh.mock.calls[0][1]).toEqual({ acceptExitCodes: [1, 8] });
    expect(r.counts).toEqual({ fail: 1, pass: 1, pending: 1 });
  });

  test('job_log tails a job log, and a run defaults to failed steps only', async () => {
    runGh.mockResolvedValueOnce(Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
    const job = await call('job_log', { repo: 'acme/app', job_id: '555', lines: 50 });
    expect(runGh.mock.calls[0][0]).toEqual(['run', 'view', '--job', '555', '-R', 'acme/app', '--log']);
    expect(job).toMatchObject({ failedOnly: false, totalLines: 300, truncated: true });
    expect(job.log.split('\n')).toHaveLength(50);
    expect(job.log.endsWith('line 300')).toBe(true);

    runGh.mockResolvedValueOnce('boom');
    const run = await call('job_log', { repo: 'acme/app', run_id: 12 });
    expect(runGh.mock.calls[1][0]).toEqual(['run', 'view', '12', '-R', 'acme/app', '--log-failed']);
    expect(run.failedOnly).toBe(true);
    await expect(call('job_log', { repo: 'acme/app' })).rejects.toThrow(/run_id or job_id/);
  });
});

describe('labels and milestones', () => {
  test('set_labels edits an issue or a PR with add/remove flags', async () => {
    runGh.mockResolvedValueOnce('');
    await call('set_labels', { repo: 'acme/app', number: 8, add: 'bug, needs-review', remove: 'triage' });
    expect(runGh.mock.calls[0][0]).toEqual(['issue', 'edit', '8', '-R', 'acme/app', '--add-label', 'bug', '--add-label', 'needs-review', '--remove-label', 'triage']);
    runGh.mockResolvedValueOnce('');
    await call('set_labels', { repo: 'acme/app', number: 9, kind: 'pr', add: 'ready' });
    expect(runGh.mock.calls[1][0].slice(0, 2)).toEqual(['pr', 'edit']);
    await expect(call('set_labels', { repo: 'acme/app', number: 9 })).rejects.toThrow(/Nothing to change/);
  });

  test('milestones list through the API and set/clear through edit', async () => {
    runGh.mockResolvedValueOnce(JSON.stringify([{ number: 1, title: 'v1', state: 'open', due_on: null, open_issues: 2, closed_issues: 5 }]));
    const list = await call('milestone_list', { repo: 'acme/app' });
    expect(runGh.mock.calls[0][0]).toEqual(['api', 'repos/acme/app/milestones?state=open&per_page=100']);
    expect(list).toEqual([{ number: 1, title: 'v1', state: 'open', description: null, dueOn: null, openIssues: 2, closedIssues: 5 }]);
    runGh.mockResolvedValueOnce('');
    await call('set_milestone', { repo: 'acme/app', number: 8, milestone: 'v1' });
    expect(runGh.mock.calls[1][0]).toEqual(['issue', 'edit', '8', '-R', 'acme/app', '--milestone', 'v1']);
    runGh.mockResolvedValueOnce('');
    await call('set_milestone', { repo: 'acme/app', number: 8, kind: 'pr', milestone: '' });
    expect(runGh.mock.calls[2][0]).toEqual(['pr', 'edit', '8', '-R', 'acme/app', '--remove-milestone']);
  });
});

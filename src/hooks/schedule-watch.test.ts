/**
 * Watch — the skip decision and the fingerprint of a recurring scheduled
 * agent hook (hooks/schedule-watch.ts), with injected probes: no network,
 * mailbox, `gh` or database.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import type { Hook } from '@/db/schema/hooks';
import { formatWatchSource, parseWatchLines, type WatchSource, type WatchState } from '@/shared/schedule-watch';
import { checkScheduleWatch, decideWatch, defaultWatchProbeDeps, probeWatch, storedWatchState, type WatchProbeDeps, watchEditError } from './schedule-watch';

const userId = '11111111-1111-4111-8111-111111111111';
const state = (fingerprint: string | null, outcome: WatchState['outcome']): WatchState => ({ fingerprint, outcome, runId: 'r1', at: '2026-11-16T08:00:00.000Z' });

function hook(actionConfig: Record<string, unknown> = { orchestrated: true, agentPrompt: 'Summarize what changed.' }) {
  return { userId, workspaceId: null, actionConfig } as unknown as Pick<Hook, 'userId' | 'workspaceId' | 'actionConfig'>;
}

/** Probes that return `values[kind]`, or throw for a kind listed in `down`. */
function fakeDeps(values: Record<string, unknown>, down: string[] = []): WatchProbeDeps {
  const read = (kind: string) => async () => {
    if (down.includes(kind)) throw new Error(`${kind} unavailable`);
    return values[kind];
  };
  return { page: read('url'), path: read('file'), tasks: read('tasks'), inbox: read('inbox'), githubPrs: read('github_prs') };
}

describe('decideWatch', () => {
  test('unchanged after a successful run → skip', () => {
    expect(decideWatch(state('abc', 'success'), 'abc')).toEqual({ run: false, reason: 'unchanged' });
  });
  test('unchanged after a failed run → run', () => {
    expect(decideWatch(state('abc', 'failed'), 'abc')).toEqual({ run: true, reason: 'last_run_not_successful' });
  });
  test('unchanged after a run in progress, never finished, or not confirmed → run', () => {
    expect(decideWatch(state('abc', 'running'), 'abc')).toEqual({ run: true, reason: 'last_run_not_successful' });
    expect(decideWatch(state('abc', 'unconfirmed'), 'abc')).toEqual({ run: true, reason: 'last_run_not_successful' });
  });
  test('a source unavailable → run, even when the last run succeeded', () => {
    expect(decideWatch(state('abc', 'success'), null)).toEqual({ run: true, reason: 'unavailable' });
  });
  test('changed → run', () => {
    expect(decideWatch(state('abc', 'success'), 'def')).toEqual({ run: true, reason: 'changed' });
  });
  test('no earlier run, or one taken while a source was unavailable → run', () => {
    expect(decideWatch(undefined, 'abc')).toEqual({ run: true, reason: 'no_baseline' });
    expect(decideWatch(state(null, 'success'), 'abc')).toEqual({ run: true, reason: 'no_baseline' });
  });
  test('a malformed stored state is no state', () => {
    expect(storedWatchState({ watchState: { fingerprint: 'abc', outcome: 'done' } } as never)).toBeUndefined();
    expect(storedWatchState({ watchState: state('abc', 'success') } as never)).toEqual(state('abc', 'success'));
  });
});

describe('probeWatch', () => {
  const watch: WatchSource[] = [{ kind: 'tasks' }, { kind: 'url', url: 'https://example.com/status' }];

  test('the same observations give the same fingerprint; a changed one a different one', async () => {
    const a = await probeWatch(hook(), watch, fakeDeps({ tasks: { count: 3, latest: 't1' }, url: 'h1' }));
    const b = await probeWatch(hook(), watch, fakeDeps({ url: 'h1', tasks: { latest: 't1', count: 3 } }));
    const c = await probeWatch(hook(), watch, fakeDeps({ tasks: { count: 4, latest: 't2' }, url: 'h1' }));
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
    expect(a.unavailable).toEqual([]);
  });

  test('editing the prompt changes the fingerprint, so the next run runs', async () => {
    const values = { tasks: { count: 3 }, url: 'h1' };
    const before = await probeWatch(hook(), watch, fakeDeps(values));
    const after = await probeWatch(hook({ orchestrated: true, agentPrompt: 'Something else.' }), watch, fakeDeps(values));
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('a source that cannot be read leaves no fingerprint (unavailable is never unchanged)', async () => {
    const probe = await probeWatch(hook(), watch, fakeDeps({ tasks: { count: 3 } }, ['url']));
    expect(probe.fingerprint).toBeNull();
    expect(probe.unavailable).toEqual([{ kind: 'url', reason: 'url unavailable' }]);
    expect(decideWatch(state('anything', 'success'), probe.fingerprint).run).toBe(true);
  });

  test('a probe that hangs counts as unavailable, and is told to stop', async () => {
    let aborted = false;
    const deps = { ...fakeDeps({}), tasks: (_owner: unknown, signal: AbortSignal) => new Promise<never>(() => { signal.addEventListener('abort', () => { aborted = true; }); }) };
    const probe = await probeWatch(hook(), [{ kind: 'tasks' }], deps, 20);
    expect(probe.fingerprint).toBeNull();
    expect(probe.unavailable[0]?.reason).toMatch(/Timed out/);
    expect(aborted).toBe(true);
  });

  test('no source to read is unavailable, not unchanged', async () => {
    const probe = await probeWatch(hook(), [], fakeDeps({}));
    expect(probe.fingerprint).toBeNull();
  });

  test('a file source: content hash, a directory listing, and absence are observations', async () => {
    // Relative paths resolve in the owner's workspace (WorkspaceFS), here a scratch data root.
    const saved = process.env.WORKSPACE_PATH;
    process.env.WORKSPACE_PATH = mkdtempSync(join(tmpdir(), 'octipus-watch-'));
    const { resetConfig, loadConfig } = await import('@/config');
    resetConfig();
    loadConfig();
    onTestFinished(() => {
      if (saved === undefined) delete process.env.WORKSPACE_PATH;
      else process.env.WORKSPACE_PATH = saved;
      resetConfig();
    });
    const { WorkspaceFS } = await import('@/security/workspace-fs');
    const { backgroundUserPrincipal } = await import('@/core/tasks/sourced');
    const root = WorkspaceFS.forPrincipal(backgroundUserPrincipal(userId)).root;
    expect(root.startsWith(process.env.WORKSPACE_PATH as string)).toBe(true);
    mkdirSync(join(root, 'inbox'), { recursive: true });
    writeFileSync(join(root, 'notes.md'), 'one');
    const owner = { userId, workspaceId: null };
    const live = new AbortController().signal;
    const file = await defaultWatchProbeDeps.path(owner, 'notes.md', live);
    expect(await defaultWatchProbeDeps.path(owner, 'notes.md', live)).toEqual(file);
    writeFileSync(join(root, 'notes.md'), 'two');
    expect(await defaultWatchProbeDeps.path(owner, 'notes.md', live)).not.toEqual(file);
    const dir = await defaultWatchProbeDeps.path(owner, 'inbox', live);
    writeFileSync(join(root, 'inbox', 'new.txt'), 'x');
    expect(await defaultWatchProbeDeps.path(owner, 'inbox', live)).not.toEqual(dir);
    expect(await defaultWatchProbeDeps.path(owner, 'missing.md', live)).toEqual({ exists: false });
    // Outside the owner's workspace: unavailable, not "absent".
    await expect(defaultWatchProbeDeps.path(owner, '../../../../../../etc/hostname', live)).rejects.toThrow(/outside/);
  });
});

describe('checkScheduleWatch', () => {
  const base = { trigger: 'schedule', triggerConfig: { cronExpression: '0 9 * * *', watch: [{ kind: 'inbox' }] }, action: 'spawn_agent', actionConfig: { orchestrated: true } };

  test('a recurring orchestrated agent schedule may watch; none or [] is no watch', () => {
    expect(checkScheduleWatch(base)).toEqual({ ok: true, watch: [{ kind: 'inbox' }] });
    expect(checkScheduleWatch({ ...base, triggerConfig: { cronExpression: '0 9 * * *' } })).toEqual({ ok: true, watch: undefined });
    expect(checkScheduleWatch({ ...base, triggerConfig: { cronExpression: '0 9 * * *', watch: [] } })).toEqual({ ok: true, watch: undefined });
  });

  test('reminders, digests, one-shots and direct spawns never skip, so cannot watch', () => {
    expect(checkScheduleWatch({ ...base, action: 'notify' }).ok).toBe(false);
    expect(checkScheduleWatch({ ...base, actionConfig: { orchestrated: true, awayDigestHours: 12 } }).ok).toBe(false);
    expect(checkScheduleWatch({ ...base, triggerConfig: { scheduledAt: '2026-12-01T09:00:00Z', watch: [{ kind: 'inbox' }] } }).ok).toBe(false);
    expect(checkScheduleWatch({ ...base, actionConfig: { orchestrated: false } }).ok).toBe(false);
    expect(checkScheduleWatch({ ...base, trigger: 'heartbeat' }).ok).toBe(false);
  });

  test('sources are validated and bounded', () => {
    const many = Array.from({ length: 6 }, () => ({ kind: 'tasks' }));
    expect(checkScheduleWatch({ ...base, triggerConfig: { cronExpression: '0 9 * * *', watch: many } })).toMatchObject({ ok: false });
    expect(checkScheduleWatch({ ...base, triggerConfig: { cronExpression: '0 9 * * *', watch: [{ kind: 'url', url: 'file:///etc/passwd' }] } })).toMatchObject({ ok: false });
    expect(checkScheduleWatch({ ...base, triggerConfig: { cronExpression: '0 9 * * *', watch: [{ kind: 'shell', cmd: 'ls' }] } })).toMatchObject({ ok: false });
    expect(checkScheduleWatch({ ...base, triggerConfig: { cronExpression: '0 9 * * *', watch: [{ kind: 'tasks', extra: 1 }] } })).toMatchObject({ ok: false });
    expect(checkScheduleWatch({ ...base, triggerConfig: { cronExpression: '0 9 * * *', watch: [{ kind: 'file', path: ' notes/today.md ' }] } }))
      .toEqual({ ok: true, watch: [{ kind: 'file', path: 'notes/today.md' }] });
  });
});

describe('watchEditError', () => {
  const watching = { trigger: 'schedule', triggerConfig: { cronExpression: '0 9 * * *', watch: [{ kind: 'tasks' }] }, action: 'spawn_agent', actionConfig: { orchestrated: true } };

  test('an action-only edit is refused only when it makes a watching hook ineligible, and says to remove watch', () => {
    const direct = { ...watching, actionConfig: { orchestrated: false } };
    expect(watchEditError(watching, direct, false)).toMatch(/remove `watch`/);
    expect(watchEditError(watching, { ...watching, actionConfig: { orchestrated: true, agentPrompt: 'new' } }, false)).toBeNull();
    // A hook whose stored watch was already ineligible stays editable.
    const reminder = { ...watching, action: 'notify', actionConfig: {} };
    expect(watchEditError(reminder, { ...reminder, actionConfig: { notifyMessage: 'x' } }, false)).toBeNull();
  });

  test('an edit that writes triggerConfig is checked in full', () => {
    const reminder = { ...watching, action: 'notify', actionConfig: {} };
    expect(watchEditError(reminder, reminder, true)).toMatch(/remove `watch`/);
  });
});

describe('the editor list format', () => {
  test('round-trips and names the line it cannot read', () => {
    const text = 'url https://example.com/a\n\nfile notes/today.md\ntasks\ninbox\ngithub_prs';
    const parsed = parseWatchLines(text);
    expect(parsed).toEqual({ sources: [
      { kind: 'url', url: 'https://example.com/a' }, { kind: 'file', path: 'notes/today.md' }, { kind: 'tasks' }, { kind: 'inbox' }, { kind: 'github_prs' },
    ] });
    if ('sources' in parsed) expect(parsed.sources.map(formatWatchSource).join('\n')).toBe(text.replace('\n\n', '\n'));
    expect(parseWatchLines('rss https://x')).toMatchObject({ error: expect.stringContaining('unknown source') });
    expect(parseWatchLines('url')).toMatchObject({ error: expect.stringContaining('needs a URL') });
    expect(parseWatchLines('tasks mine')).toMatchObject({ error: expect.stringContaining('takes no argument') });
  });
});

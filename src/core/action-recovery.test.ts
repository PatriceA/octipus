import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ActionRecovery, isReadOnlyAction } from './action-recovery';
import { ToolActionRepository } from '@/db/repositories/tool-action-repository';
import type { ToolAction, toolActions } from '@/db/schema/tool-actions';
import * as permissions from '@/security/permissions';
import type { AgentContext } from './types';

class MemoryJournal extends ToolActionRepository {
  rows: ToolAction[] = [];
  override async start(row: typeof toolActions.$inferInsert) {
    this.rows.push({ ...row, pipelineId: row.pipelineId ?? null, nodeKey: row.nodeKey ?? null,
      createdAt: new Date(), finishedAt: null, reviewedAt: null, reviewId: null });
  }
  override async finish(scope: Pick<ToolAction, 'id' | 'userId' | 'sessionId'>, status: ToolAction['status']) {
    const row = this.rows.find(r => r.id === scope.id)!; row.status = status;
  }
  override async pending(userId: string, sessionId: string) {
    return this.rows.filter(r => r.userId === userId && r.sessionId === sessionId && !r.reviewedAt && ['started', 'uncertain'].includes(r.status));
  }
  override async pipeline(userId: string, sessionId: string, pipelineId: string) {
    return this.rows.filter(r => r.userId === userId && r.sessionId === sessionId && r.pipelineId === pipelineId && !r.reviewedAt && r.status !== 'not_executed');
  }
  override async acknowledge(userId: string, sessionId: string, ids: string[], reviewId: string) {
    for (const row of this.rows) if (row.userId === userId && row.sessionId === sessionId && ids.includes(row.id)) {
      row.reviewedAt = new Date(); row.reviewId = reviewId;
    }
  }
}
const ctx = (): AgentContext => ({ id: 'worker', userId: 'u', sessionId: 's', status: 'running', root: true,
  attended: true, role: 'general', model: 'fake', topic: '', createdAt: new Date(), updatedAt: new Date(), metadata: { pipelineId: 'p', nodeKey: 'step' } });
let repo: MemoryJournal;
let recovery: ActionRecovery;
let request: ReturnType<typeof vi.fn>;
let wait: ReturnType<typeof vi.fn>;
beforeEach(() => {
  repo = new MemoryJournal(); recovery = new ActionRecovery(repo);
  request = vi.fn().mockResolvedValue('review-1'); wait = vi.fn().mockResolvedValue(true);
  vi.spyOn(permissions, 'getPermissionManager').mockReturnValue({ requestApproval: request, waitForApproval: wait } as unknown as permissions.PermissionManager);
});
afterEach(() => vi.restoreAllMocks());
const run = (execute: () => Promise<unknown>, context = ctx()) => recovery.run(context, 'mail', 'mail__send', { to: 'example' }, execute);

async function uncertain() {
  await expect(run(async () => { throw new Error('connection lost after sending'); })).rejects.toThrow('connection lost');
}

describe('durable action recovery', () => {
  test('records intent before the action, with no arguments or results in the journal', async () => {
    const result = await run(async () => { expect(repo.rows[0].status).toBe('started'); return 'sent'; });
    expect(result).toBe('sent'); expect(repo.rows[0].status).toBe('completed');
    expect(JSON.stringify(repo.rows)).not.toContain('example');
    expect(JSON.stringify(repo.rows)).not.toContain('sent');
  });
  test('cannot dispatch if the intent cannot be saved', async () => {
    vi.spyOn(repo, 'start').mockRejectedValue(new Error('DB unavailable'));
    const execute = vi.fn(); await expect(run(execute)).rejects.toThrow('DB unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
  test('an acknowledged side effect with a lost completion record preserves output and gates the next mutation', async () => {
    const save = vi.spyOn(repo, 'finish').mockRejectedValue(new Error('write lost'));
    expect(await run(async () => 'remote service returned success')).toBe('remote service returned success');
    save.mockRestore();
    expect(repo.rows[0].status).toBe('started');
    recovery = new ActionRecovery(repo); // fresh process sees durable evidence
    wait.mockResolvedValue(false); const execute = vi.fn();
    await expect(run(execute)).rejects.toThrow('not granted');
    expect(execute).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
  });
  test('a crash record blocks different arguments and different mutation tools too', async () => {
    await uncertain(); wait.mockResolvedValue(false); const execute = vi.fn();
    await expect(recovery.run(ctx(), 'issues', 'issues__create', { title: 'different' }, execute)).rejects.toThrow('not granted');
    expect(execute).not.toHaveBeenCalled();
  });
  test('approval permits continuing and records exactly which uncertainty was reviewed', async () => {
    await uncertain(); const first = repo.rows[0];
    expect(await run(async () => 'confirmed retry')).toBe('confirmed retry');
    expect(first.reviewId).toBe('review-1'); expect(first.status).toBe('uncertain');
    expect(repo.rows[1].status).toBe('completed');
  });
  test('unattended callers cannot bypass recovery through normal tool ALLOW policy', async () => {
    await uncertain(); const execute = vi.fn();
    await expect(run(execute, { ...ctx(), attended: false })).rejects.toThrow('recovery approval');
    expect(execute).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  test('uncertainty appearing during approval needs its own review', async () => {
    await uncertain();
    wait.mockImplementationOnce(async () => {
      repo.rows.push({ ...repo.rows[0], id: 'newly-uncertain', reviewedAt: null }); return true;
    }).mockResolvedValueOnce(false);
    const execute = vi.fn(); await expect(run(execute)).rejects.toThrow('not granted');
    expect(request).toHaveBeenCalledTimes(2); expect(execute).not.toHaveBeenCalled();
    expect(repo.rows[1].reviewedAt).toBeNull();
  });
  test('an active action does not look like an orphan to concurrent work', async () => {
    let finish!: () => void;
    const active = run(() => new Promise<void>(resolve => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    await run(async () => 'another action'); expect(request).not.toHaveBeenCalled();
    finish(); await active;
  });
  test('different users and sessions cannot acknowledge each other’s uncertainty', async () => {
    await uncertain();
    await run(async () => 'other session', { ...ctx(), sessionId: 'other' });
    await run(async () => 'other user', { ...ctx(), userId: 'other' });
    expect(request).not.toHaveBeenCalled(); expect(repo.rows[0].reviewedAt).toBeNull();
  });
  test('completed pipeline actions require explicit replay consent', async () => {
    await run(async () => 'sent'); const ask = vi.fn().mockResolvedValue({ approved: false });
    await expect(recovery.reviewPipeline(ctx(), 'p', true, ask)).rejects.toThrow('not approved');
    expect(ask.mock.calls[0][0]).toContain('returned previously'); expect(repo.rows[0].reviewedAt).toBeNull();
  });
  test('legacy and native CLI work without records still gets a replay warning', async () => {
    const ask = vi.fn().mockResolvedValue({ approved: true });
    await recovery.reviewPipeline(ctx(), 'p', true, ask);
    expect(ask).toHaveBeenCalledTimes(1); expect(ask.mock.calls[0][0]).toContain('outside this journal');
  });
  test('fresh paused pipelines need no replay consent', async () => {
    const ask = vi.fn(); await recovery.reviewPipeline(ctx(), 'p', false, ask); expect(ask).not.toHaveBeenCalled();
  });
  test('only explicit read actions are classified safe, never arbitrary shell commands', () => {
    expect(isReadOnlyAction('read')).toBe(true); expect(isReadOnlyAction('execute')).toBe(false);
    expect(isReadOnlyAction('get_and_send')).toBe(false);
  });
});

test('cancelling a queued mutation does not wait for another agent’s unanswered review', async () => {
  const { withExecutionSignal } = await import('./execution-scope');
  await uncertain();
  let answer!: (value: boolean) => void;
  wait.mockImplementationOnce(() => new Promise<boolean>(resolve => { answer = resolve; }));
  const first = run(async () => 'first retry');
  await vi.waitFor(() => expect(answer).toBeDefined());
  const controller = new AbortController(); const execute = vi.fn();
  const second = withExecutionSignal(ctx(), controller.signal, () => run(execute));
  const rejected = expect(second).rejects.toThrow('stopped');
  controller.abort(); await rejected;
  expect(execute).not.toHaveBeenCalled();
  answer(true); await first;
});

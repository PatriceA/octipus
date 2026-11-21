/**
 * `/proposals` — the only surface a TUI user has for approving distilled
 * skills. Pins the two things that make the positional index safe: it is
 * resolved against the same list, in the same order, the user just read, and an
 * out-of-range number resolves nothing instead of the wrong proposal.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as service from '@/services/skill-proposal-service';
import { CommandRegistry, registerBuiltinCommands } from './commands';

const proposal = (id: string, name: string, kind: 'skill' | 'expert' = 'skill', exemplarCount = 4) => ({
  id, name, kind, description: `${name} desc`, exemplarCount,
} as unknown as Awaited<ReturnType<typeof service.listPendingProposals>>[number]);

describe('/proposals', () => {
  let registry: CommandRegistry;
  const listSpy = vi.spyOn(service, 'listPendingProposals');
  const approveSpy = vi.spyOn(service, 'approveProposal');
  const rejectSpy = vi.spyOn(service, 'rejectProposal');

  const uuid = '11111111-1111-4111-8111-111111111111';
  const ctx = { userId: uuid, sessionId: 's1', clientType: 'tui', trustLevel: 'user' as const };

  beforeEach(() => {
    registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    listSpy.mockReset();
    approveSpy.mockReset();
    rejectSpy.mockReset();
    listSpy.mockResolvedValue([proposal('p-1', 'pdf-invoice-extract'), proposal('p-2', 'k8s-triage', 'expert', 1)]);
  });

  test('bare /proposals lists pending rows with numbers, and ×N for a proposal seen more than once', async () => {
    const result = await registry.execute('/proposals', ctx);
    expect(result!.text).toContain('1. pdf-invoice-extract ×4 (skill)');
    expect(result!.text).toContain('2. k8s-triage (expert)');
    expect(result!.text).not.toContain('×1');
    expect(approveSpy).not.toHaveBeenCalled();
  });

  test('empty queue says so', async () => {
    listSpy.mockResolvedValue([]);
    expect((await registry.execute('/proposals', ctx))!.text).toBe('No pending skill proposals.');
  });

  test('approve <n> promotes the nth row of that same list', async () => {
    approveSpy.mockResolvedValue({ promoted: 'skill', id: 'e-9', name: 'k8s-triage', record: {} });
    const result = await registry.execute('/proposals approve 2', ctx);
    expect(approveSpy).toHaveBeenCalledWith('p-2', { userId: uuid });
    expect(result!.text).toContain('is now a skill');
  });

  test('reject <n> reports the suppression date', async () => {
    rejectSpy.mockResolvedValue(new Date('2026-12-01T00:00:00Z'));
    const result = await registry.execute('/proposals reject 1', ctx);
    expect(rejectSpy).toHaveBeenCalledWith('p-1', uuid);
    expect(result!.text).toContain('2026-12-01');
  });

  test('an empty queue says so even when an action was typed', async () => {
    listSpy.mockResolvedValue([]);
    expect((await registry.execute('/proposals approve 1', ctx))!.text).toBe('No pending skill proposals.');
  });

  test('out-of-range and non-numeric indexes resolve nothing', async () => {
    for (const input of ['/proposals approve 3', '/proposals approve 0', '/proposals approve x', '/proposals approve']) {
      const result = await registry.execute(input, ctx);
      expect(result!.text).toContain('row number between 1 and 2');
    }
    expect(approveSpy).not.toHaveBeenCalled();
  });

  test('unknown action is refused, nothing is resolved', async () => {
    const result = await registry.execute('/proposals delete 1', ctx);
    expect(result!.text).toContain('Unknown action');
    expect(approveSpy).not.toHaveBeenCalled();
    expect(rejectSpy).not.toHaveBeenCalled();
  });

  test('a patch is listed as old → new, and a stale approval says why it was not applied', async () => {
    listSpy.mockResolvedValue([{ ...proposal('p-3', 'deploy-service'), kind: 'patch', description: 'Push failed', patchOldText: '2. Push it.', patchNewText: '2. Push it with --tag.' }]);
    const list = (await registry.execute('/proposals', ctx))!.text;
    expect(list).toContain('1. deploy-service (patch) — Push failed');
    expect(list).toContain('replace "2. Push it."');
    expect(list).toContain('with    "2. Push it with --tag."');
    approveSpy.mockRejectedValue(new service.ProposalRefusedError('stale', 'The skill changed after this patch was proposed'));
    expect((await registry.execute('/proposals approve 1', ctx))!.text).toBe('Not applied: The skill changed after this patch was proposed');
  });

  test('every caller, admins included, is scoped to their own proposals', async () => {
    await registry.execute('/proposals', ctx);
    expect(listSpy).toHaveBeenCalledWith(uuid, { order: 'surfaced' });
    expect(listSpy).not.toHaveBeenCalledWith(undefined, expect.anything());
  });

  test('the list and the numbered actions both use the stable order, not most-seen first', async () => {
    approveSpy.mockResolvedValue({ promoted: 'skill', id: 'e-9', name: 'k8s-triage', record: {} });
    rejectSpy.mockResolvedValue(new Date('2026-12-01T00:00:00Z'));
    for (const input of ['/proposals', '/proposals approve 1', '/proposals reject 1']) {
      listSpy.mockClear();
      await registry.execute(input, ctx);
      expect(listSpy).toHaveBeenCalledWith(uuid, { order: 'surfaced' });
    }
  });
});

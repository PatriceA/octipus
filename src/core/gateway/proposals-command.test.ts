/**
 * `/proposals` — the only surface a TUI user has for approving distilled
 * skills. Pins the two things that make the positional index safe: it is
 * resolved against the same oldest-first list the user just read, and an
 * out-of-range number resolves nothing instead of the wrong proposal.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as service from '@/services/skill-proposal-service';
import { CommandRegistry, registerBuiltinCommands } from './commands';

const proposal = (id: string, name: string, kind: 'skill' | 'expert' = 'skill') => ({
  id, name, kind, description: `${name} desc`, exemplarCount: 4,
} as unknown as Awaited<ReturnType<typeof service.listPendingProposals>>[number]);

describe('/proposals', () => {
  let registry: CommandRegistry;
  const listSpy = vi.spyOn(service, 'listPendingProposals');
  const approveSpy = vi.spyOn(service, 'approveProposal');
  const rejectSpy = vi.spyOn(service, 'rejectProposal');

  const ctx = { userId: 'local', sessionId: 's1', clientType: 'tui', trustLevel: 'local' as const };

  beforeEach(() => {
    registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    listSpy.mockReset();
    approveSpy.mockReset();
    rejectSpy.mockReset();
    listSpy.mockResolvedValue([proposal('p-1', 'pdf-invoice-extract'), proposal('p-2', 'k8s-triage', 'expert')]);
  });

  test('bare /proposals lists pending rows with numbers', async () => {
    const result = await registry.execute('/proposals', ctx);
    expect(result!.text).toContain('1. pdf-invoice-extract (skill)');
    expect(result!.text).toContain('2. k8s-triage (expert)');
    expect(approveSpy).not.toHaveBeenCalled();
  });

  test('empty queue says so', async () => {
    listSpy.mockResolvedValue([]);
    expect((await registry.execute('/proposals', ctx))!.text).toBe('No pending skill proposals.');
  });

  test('approve <n> promotes the nth row of that same list', async () => {
    approveSpy.mockResolvedValue({ promoted: 'expert', id: 'e-9', name: 'k8s-triage', record: {} });
    const result = await registry.execute('/proposals approve 2', ctx);
    expect(approveSpy).toHaveBeenCalledWith('p-2', { userId: undefined });
    expect(result!.text).toContain('is now an expert');
  });

  test('reject <n> reports the suppression date', async () => {
    rejectSpy.mockResolvedValue(new Date('2026-12-01T00:00:00Z'));
    const result = await registry.execute('/proposals reject 1', ctx);
    expect(rejectSpy).toHaveBeenCalledWith('p-1', undefined);
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

  test('a plain user is scoped to their own proposals', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    await registry.execute('/proposals', { ...ctx, userId: uuid, trustLevel: 'user' });
    expect(listSpy).toHaveBeenCalledWith(uuid);
  });
});

import { expect, test, vi } from 'vitest';
import { DecisionQueue } from './decision-queue';
import type { OverlayController } from './overlays/registry';
import type { GatewayAdapter } from './gateway-adapter';
test('queues, deduplicates and answers every decision on its own channel', () => {
  const shown: any[] = []; const hide = vi.fn();
  const overlays = { showApprovalPrompt: (o: unknown) => { shown.push(o); return { hide }; }, showPermissionPrompt: (o: unknown) => { shown.push(o); return { hide }; } } as unknown as OverlayController;
  const adapter = { respondApproval: vi.fn(), respondPermission: vi.fn() } as unknown as GatewayAdapter;
  const queue = new DecisionQueue(overlays, adapter, vi.fn(), vi.fn());
  const a = { kind: 'approval' as const, requestId: 'a', summary: '', question: 'Choose?', options: ['A'] };
  queue.push(a); queue.push(a); queue.push({ kind: 'permission', requestId: 'b', toolName: 'write', detail: 'file' });
  expect(shown).toHaveLength(1); shown[0].onRespond(true, 'A');
  expect(adapter.respondApproval).toHaveBeenCalledWith('a', true, 'A');
  expect(shown).toHaveLength(2); queue.dispose();
  expect(adapter.respondPermission).toHaveBeenCalledWith('b', false);
});

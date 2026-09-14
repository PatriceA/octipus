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

test('an external permission decision closes only that prompt without sending another answer', () => {
  const shown: Array<Parameters<OverlayController['showPermissionPrompt']>[0]> = [];
  const hide = vi.fn(); const restore = vi.fn();
  const overlays = { showPermissionPrompt: (options: Parameters<OverlayController['showPermissionPrompt']>[0]) => {
    shown.push(options); return { hide };
  } } as unknown as OverlayController;
  const adapter = { respondPermission: vi.fn(), respondApproval: vi.fn() } as unknown as GatewayAdapter;
  const queue = new DecisionQueue(overlays, adapter, vi.fn(), restore);
  queue.push({ kind: 'permission', requestId: 'first', toolName: 'write', detail: '' });
  queue.push({ kind: 'permission', requestId: 'next', toolName: 'send', detail: '' });
  queue.resolve('first', 'approved');
  expect(hide).toHaveBeenCalledTimes(1);
  expect(shown).toHaveLength(2);
  shown[0].onDeny(); // A callback retained by the dismissed overlay is inert.
  expect(adapter.respondPermission).not.toHaveBeenCalled();
  queue.resolve('next', 'expired');
  expect(restore).toHaveBeenCalledTimes(1);
  queue.dispose();
  expect(adapter.respondPermission).not.toHaveBeenCalled();
});

test('an externally resolved queued request is removed and late request replay is ignored', () => {
  const show = vi.fn(() => ({ hide: vi.fn() }));
  const overlays = { showPermissionPrompt: show } as unknown as OverlayController;
  const adapter = { respondPermission: vi.fn() } as unknown as GatewayAdapter;
  const queue = new DecisionQueue(overlays, adapter, vi.fn(), vi.fn());
  queue.push({ kind: 'permission', requestId: 'active', toolName: 'write', detail: '' });
  queue.push({ kind: 'permission', requestId: 'queued', toolName: 'send', detail: '' });
  queue.resolve('queued', 'denied');
  queue.resolve('late', 'approved');
  queue.push({ kind: 'permission', requestId: 'late', toolName: 'send', detail: '' });
  expect(show).toHaveBeenCalledTimes(1);
  queue.dispose();
  expect(adapter.respondPermission).toHaveBeenCalledExactlyOnceWith('active', false);
});

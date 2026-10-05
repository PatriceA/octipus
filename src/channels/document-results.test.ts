/**
 * Document summaries for an attachment shared in a group channel thread go
 * back into that thread, not to the top of the channel — and only for the
 * documents that message produced, never for another document of the same
 * user that happens to finish meanwhile.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@/db/repositories/document-repository', () => ({ documentRepository: {
  findByIdSystem: async (id: string) => ({ id, userId: 'u-anna', originalName: 'contract.pdf', summary: 'Two-year term.', category: 'legal' }),
} }));
import { subscribeToDocumentResults } from './index';

describe('subscribeToDocumentResults', () => {
  test('summaries and failures carry the thread; other documents of the user are not reported', async () => {
    const queue = new EventEmitter();
    const send = vi.fn(async () => 'ts');
    const umi = { send } as unknown as import('./interface').UnifiedMessageInterface;
    const message = {
      id: 'm', channelType: 'slack' as const, channelId: 'C1', userId: 'u-anna', content: '',
      timestamp: new Date(), threadId: '90.0',
      attachments: [{ type: 'file' as const, url: 'u', mimeType: 'application/pdf' }, { type: 'file' as const, url: 'v', mimeType: 'application/pdf' }],
    };
    subscribeToDocumentResults(message, umi, Promise.resolve(['doc-1', 'doc-2']), undefined, '90.0', queue);
    // A private upload of the same user (DM, web app) finishing in the window.
    queue.emit('completed', 'doc-private', 'u-anna');
    queue.emit('failed', 'doc-private-2', 'boom', 'u-anna');
    await new Promise((r) => setTimeout(r, 10));
    expect(send).not.toHaveBeenCalled();
    queue.emit('completed', 'doc-1', 'u-anna');
    await new Promise((r) => setTimeout(r, 10));
    queue.emit('failed', 'doc-2', 'unreadable', 'u-anna');
    await new Promise((r) => setTimeout(r, 10));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 'slack', 'C1', expect.objectContaining({ threadId: '90.0', content: expect.stringContaining('contract.pdf') }));
    expect(send).toHaveBeenNthCalledWith(2, 'slack', 'C1', expect.objectContaining({ threadId: '90.0', content: expect.stringContaining('unreadable') }));
  });

  test('when nothing was enqueued the member is told at once and no listener is left behind', async () => {
    const queue = new EventEmitter();
    const send = vi.fn(async () => 'ts');
    const umi = { send } as unknown as import('./interface').UnifiedMessageInterface;
    const message = {
      id: 'm', channelType: 'slack' as const, channelId: 'C1', userId: 'u-anna', content: '',
      timestamp: new Date(), threadId: '90.0', attachments: [{ type: 'file' as const, url: 'u', mimeType: 'application/pdf' }],
    };
    subscribeToDocumentResults(message, umi, Promise.resolve([]), undefined, '90.0', queue);
    await new Promise((r) => setTimeout(r, 10));
    expect(send).toHaveBeenCalledWith('slack', 'C1', expect.objectContaining({ threadId: '90.0', content: expect.stringContaining('could not process') }));
    expect(queue.listenerCount('completed') + queue.listenerCount('failed')).toBe(0);
  });
});

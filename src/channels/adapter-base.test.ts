import { describe, test, expect } from 'bun:test';
import { GatewayAdapter } from './adapter-base';
import type { GatewayToAdapter } from './adapter-base';
import type { ChannelType } from '@/core/types';

// Concrete test adapter
class TestAdapter extends GatewayAdapter {
  readonly channelType: ChannelType = 'webchat';
  readonly name = 'Test';

  startCalled = false;
  stopCalled = false;
  sentMessages: any[] = [];

  async start() { this.startCalled = true; this.emitStatus(true); }
  async stop() { this.stopCalled = true; this.emitStatus(false); }
  async handleSend(payload: GatewayToAdapter['channel.send']) {
    this.sentMessages.push(payload);
  }
}

describe('GatewayAdapter', () => {
  test('emitMessage sends via gateway callback', () => {
    const adapter = new TestAdapter();
    const received: any[] = [];
    adapter.setGatewaySend((type, payload) => received.push({ type, payload }));

    (adapter as any).emitMessage({
      channel: 'webchat',
      channelId: 'ch1',
      userId: 'u1',
      content: 'Hello',
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('channel.message');
    expect(received[0].payload.content).toBe('Hello');
  });

  test('emitStatus updates connected state and sends to gateway', () => {
    const adapter = new TestAdapter();
    const received: any[] = [];
    adapter.setGatewaySend((type, payload) => received.push({ type, payload }));

    expect(adapter.isConnected()).toBe(false);

    (adapter as any).emitStatus(true);
    expect(adapter.isConnected()).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('channel.status');
    expect(received[0].payload.connected).toBe(true);
  });

  test('handleGatewayMessage routes to handleSend', async () => {
    const adapter = new TestAdapter();
    await adapter.handleGatewayMessage('channel.send', {
      channel: 'webchat',
      channelId: 'ch1',
      content: 'Reply',
    });
    expect(adapter.sentMessages).toHaveLength(1);
    expect(adapter.sentMessages[0].content).toBe('Reply');
  });

  test('handleGatewayMessage handles unknown type gracefully', async () => {
    const adapter = new TestAdapter();
    // Should not throw
    await adapter.handleGatewayMessage('unknown.type', {});
  });

  test('start/stop lifecycle', async () => {
    const adapter = new TestAdapter();
    await adapter.start();
    expect(adapter.startCalled).toBe(true);
    expect(adapter.isConnected()).toBe(true);

    await adapter.stop();
    expect(adapter.stopCalled).toBe(true);
    expect(adapter.isConnected()).toBe(false);
  });

  test('emitMessage without gateway send does not throw', () => {
    const adapter = new TestAdapter();
    // No gatewaySend set — should not throw
    (adapter as any).emitMessage({
      channel: 'webchat',
      channelId: 'ch1',
      userId: 'u1',
      content: 'Hello',
    });
  });
});

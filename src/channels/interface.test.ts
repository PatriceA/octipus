import { describe, test, expect } from 'bun:test';
import type { ChannelResponse, ChannelType } from '@/core/types';
import { BaseChannel, UnifiedMessageInterface } from './interface';

// Note: Channel interface tests require full channel implementation
// These are unit tests for message structures

describe('Channel Interface (Unit)', () => {
  describe('unified message structure', () => {
    test('has required fields', () => {
      const message = {
        id: 'msg-123',
        channel: 'telegram',
        userId: 'user-456',
        content: 'Hello!',
        timestamp: new Date(),
      };

      expect(message.id).toBeDefined();
      expect(message.channel).toBeDefined();
      expect(message.userId).toBeDefined();
      expect(message.content).toBeDefined();
      expect(message.timestamp).toBeInstanceOf(Date);
    });

    test('supports optional fields', () => {
      const message = {
        id: 'msg-123',
        channel: 'telegram',
        userId: 'user-456',
        content: 'Hello!',
        timestamp: new Date(),
        replyTo: 'msg-122',
        attachments: [],
        metadata: { customField: 'value' },
      };

      expect(message.replyTo).toBeDefined();
      expect(message.attachments).toBeInstanceOf(Array);
      expect(message.metadata).toBeDefined();
    });
  });

  describe('channel types', () => {
    const channels = ['telegram', 'slack', 'teams', 'webchat'];

    test('all channel types are valid', () => {
      for (const channel of channels) {
        expect(typeof channel).toBe('string');
      }
    });
  });

  describe('message normalization', () => {
    test('telegram message has expected fields', () => {
      const telegramMsg = {
        message_id: 123,
        from: { id: 456, username: 'testuser' },
        chat: { id: 789 },
        text: 'Hello',
        date: 1234567890,
      };

      expect(telegramMsg.message_id).toBeDefined();
      expect(telegramMsg.from.id).toBeDefined();
      expect(telegramMsg.text).toBeDefined();
    });

    test('slack message has expected fields', () => {
      const slackMsg = {
        ts: '1234567890.123456',
        user: 'U12345',
        channel: 'C12345',
        text: 'Hello',
      };

      expect(slackMsg.ts).toBeDefined();
      expect(slackMsg.user).toBeDefined();
      expect(slackMsg.text).toBeDefined();
    });
  });

  describe('attachment handling', () => {
    test('image attachment structure', () => {
      const attachment = {
        type: 'image',
        fileId: 'file-123',
        mimeType: 'image/png',
        size: 1024,
      };

      expect(attachment.type).toBe('image');
      expect(attachment.fileId).toBeDefined();
    });

    test('document attachment structure', () => {
      const attachment = {
        type: 'document',
        fileId: 'file-456',
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
      };

      expect(attachment.type).toBe('document');
      expect(attachment.fileName).toBeDefined();
    });

    test('voice attachment structure', () => {
      const attachment = {
        type: 'voice',
        fileId: 'voice-789',
        duration: 10,
      };

      expect(attachment.type).toBe('voice');
      expect(attachment.duration).toBeGreaterThan(0);
    });
  });

  describe('command parsing', () => {
    test('parses /command format', () => {
      const text = '/start';
      const isCommand = text.startsWith('/');
      const command = text.slice(1).split(' ')[0];

      expect(isCommand).toBe(true);
      expect(command).toBe('start');
    });

    test('parses command with arguments', () => {
      const text = '/search hello world';
      const parts = text.slice(1).split(' ');
      const command = parts[0];
      const args = parts.slice(1);

      expect(command).toBe('search');
      expect(args).toEqual(['hello', 'world']);
    });

    test('handles bot mention in command', () => {
      const text = '/help@mybot';
      const match = text.match(/^\/(\w+)(?:@(\w+))?/);

      expect(match?.[1]).toBe('help');
      expect(match?.[2]).toBe('mybot');
    });
  });

  describe('mention extraction', () => {
    test('extracts @mentions', () => {
      const text = 'Hey @user1 and @user2';
      const mentions = text.match(/@(\w+)/g)?.map(m => m.slice(1)) || [];

      expect(mentions).toContain('user1');
      expect(mentions).toContain('user2');
    });
  });
});

class TestChannel extends BaseChannel {
  readonly type = 'webchat' as ChannelType;
  readonly name = 'Test';
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async send(_channelId: string, _response: ChannelResponse): Promise<string> {
    return '';
  }
  emitTestError(e: Error): void {
    this.emitError(e);
  }
}

describe('channel error isolation', () => {
  test('UMI emitting an error event with no external listener does not throw', () => {
    // EventEmitter throws on an unlistened 'error' event; the UMI's default
    // listener must prevent one channel error from crashing the process.
    const umi = new UnifiedMessageInterface();
    expect(() => umi.emit('error', 'webchat' as ChannelType, new Error('boom'))).not.toThrow();
  });

  test('channel emitError does not throw before or after registration', () => {
    const ch = new TestChannel();
    // Before register: BaseChannel's own default 'error' listener prevents a throw.
    expect(() => ch.emitTestError(new Error('pre-register'))).not.toThrow();
    // After register: the forward to umi.emit('error', …) is also safe.
    const umi = new UnifiedMessageInterface();
    umi.register(ch);
    expect(() => ch.emitTestError(new Error('post-register'))).not.toThrow();
  });
});

import { describe, test, expect } from 'bun:test';
import { parseClientMessage, matchesPattern, PROTOCOL_VERSION, SUPPORTED_VERSIONS } from './protocol';

describe('Protocol', () => {
  describe('parseClientMessage — additional coverage', () => {
    test('parses permission.respond', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'permission.respond',
        requestId: 'req-123',
        approved: true,
      }));
      expect(result.ok).toBe(true);
    });

    test('parses approval.respond', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'approval.respond',
        requestId: 'req-456',
        response: 'Approve',
        approved: true,
      }));
      expect(result.ok).toBe(true);
    });

    test('parses agent.stop', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'agent.stop',
        agentId: 'agent-789',
      }));
      expect(result.ok).toBe(true);
    });

    test('parses unsubscribe', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'unsubscribe',
        patterns: ['agent.*'],
      }));
      expect(result.ok).toBe(true);
    });

    test('rejects subscribe with too many patterns', () => {
      const patterns = Array.from({ length: 51 }, (_, i) => `pattern.${i}`);
      const result = parseClientMessage(JSON.stringify({
        type: 'subscribe',
        patterns,
      }));
      expect(result.ok).toBe(false);
    });

    test('parses chat.send with attachments', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'Check this file',
        attachments: [{ name: 'test.txt', mimeType: 'text/plain', data: 'base64data' }],
      }));
      expect(result.ok).toBe(true);
    });

    test('parses chat.send with edit-and-continue fileRefs', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'make it rhyme',
        fileRefs: [{ path: 'poem.md', version: 'abc123def4567890' }, { path: 'notes.txt' }],
      }));
      expect(result.ok).toBe(true);
    });

    test('parses chat.send with an outputMode override', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'write me a poem',
        outputMode: 'file',
      }));
      expect(result.ok).toBe(true);
    });

    test('rejects chat.send with an invalid outputMode', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'hi',
        outputMode: 'pdf',
      }));
      expect(result.ok).toBe(false);
    });

    test('rejects chat.send with a fileRef missing its path', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'make it rhyme',
        fileRefs: [{ version: 'abc123' }],
      }));
      expect(result.ok).toBe(false);
    });

    test('parses auth with all client types', () => {
      for (const ct of ['webchat', 'tui', 'channel', 'mobile', 'acp', 'agent']) {
        const result = parseClientMessage(JSON.stringify({
          type: 'auth',
          method: 'session_token',
          credentials: { token: 'x' },
          clientType: ct,
        }));
        expect(result.ok).toBe(true);
      }
    });

    test('rejects auth with invalid client type', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'auth',
        method: 'session_token',
        credentials: { token: 'x' },
        clientType: 'invalid_type',
      }));
      expect(result.ok).toBe(false);
    });

    test('rejects chat.send with content over 100k chars', () => {
      const result = parseClientMessage(JSON.stringify({
        type: 'chat.send',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'x'.repeat(100_001),
      }));
      expect(result.ok).toBe(false);
    });
  });

  describe('matchesPattern — additional coverage', () => {
    test('nested prefix wildcard', () => {
      expect(matchesPattern('gateway.connection.open', 'gateway.*')).toBe(true);
    });

    test('does not partial match without wildcard', () => {
      expect(matchesPattern('agent.spawned', 'agent')).toBe(false);
    });

    test('empty pattern matches nothing', () => {
      expect(matchesPattern('agent.spawned', '')).toBe(false);
    });
  });

  test('SUPPORTED_VERSIONS includes current version', () => {
    expect(SUPPORTED_VERSIONS).toContain(PROTOCOL_VERSION);
  });
});

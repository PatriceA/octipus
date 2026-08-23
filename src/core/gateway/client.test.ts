import { describe, expect, test } from 'vitest';
import { GatewayClient } from './client';

/**
 * Regression: `respondPermission` used to emit `approval.respond` (the
 * orchestrator-approval channel) rather than `permission.respond` (the
 * tool-permission channel). The two are routed by different handlers
 * server-side, so the TUI's "approve" tap landed in the wrong queue
 * and never released the waiting agent — users had to re-approve from
 * a different surface (e.g. web UI) for the tool to actually run.
 *
 * These tests pin the wire format. They use a minimal stub WebSocket
 * to avoid spinning up a real connection.
 */

interface SentMessage {
  type: string;
  [k: string]: unknown;
}

function stubClient() {
  const sent: SentMessage[] = [];
  const client = new GatewayClient({});
  // Inject a stub WS that records every send. The client only checks
  // `this.ws?.readyState === OPEN` and then calls `this.ws.send(json)`.
  (client as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw) as SentMessage),
  };
  return { client, sent };
}

describe('GatewayClient — permission/approval wire format', () => {
  test('respondPermission emits `permission.respond` with requestId + approved', () => {
    const { client, sent } = stubClient();
    client.respondPermission('req-1', true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'permission.respond',
      requestId: 'req-1',
      approved: true,
    });
  });

  test('respondPermission(false) emits a deny on the same channel', () => {
    const { client, sent } = stubClient();
    client.respondPermission('req-2', false);
    expect(sent[0]).toEqual({
      type: 'permission.respond',
      requestId: 'req-2',
      approved: false,
    });
  });

  test('respondApproval emits `approval.respond` with response text', () => {
    const { client, sent } = stubClient();
    client.respondApproval('req-3', true);
    expect(sent[0]).toMatchObject({
      type: 'approval.respond',
      requestId: 'req-3',
      approved: true,
      response: 'yes',
    });
  });

  test('respondApproval allows a custom response string (multi-option prompts)', () => {
    const { client, sent } = stubClient();
    client.respondApproval('req-4', true, 'keep going');
    expect(sent[0]).toEqual({
      type: 'approval.respond',
      requestId: 'req-4',
      approved: true,
      response: 'keep going',
    });
  });

  test('the two channels are distinct (cross-wiring would re-introduce the original bug)', () => {
    const { client, sent } = stubClient();
    client.respondPermission('p-1', true);
    client.respondApproval('a-1', true);
    expect(sent[0].type).toBe('permission.respond');
    expect(sent[1].type).toBe('approval.respond');
  });
});

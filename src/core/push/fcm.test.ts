import { describe, expect, test } from 'vitest';
import { buildFcmMessage, isUnregistered } from './fcm';

describe('buildFcmMessage', () => {
  test('carries title, body and string data for one token', () => {
    const m = buildFcmMessage('tok-1', {
      title: 'Permission request',
      body: 'shell run',
      data: { kind: 'permission', requestId: 'r1' },
    });
    expect(m.token).toBe('tok-1');
    expect(m.notification).toEqual({ title: 'Permission request', body: 'shell run' });
    expect(m.data).toEqual({ kind: 'permission', requestId: 'r1' });
    expect(m.android.priority).toBe('high');
  });

  test('omits body when absent and defaults data to an empty object', () => {
    const m = buildFcmMessage('tok-2', { title: 'Done' });
    expect(m.notification).toEqual({ title: 'Done' });
    expect(m.data).toEqual({});
  });
});

describe('isUnregistered', () => {
  test('matches the FCM UNREGISTERED error detail only', () => {
    const gone = JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } });
    const badBody = JSON.stringify({ error: { status: 'INVALID_ARGUMENT', details: [{ errorCode: 'INVALID_ARGUMENT' }] } });
    expect(isUnregistered(gone)).toBe(true);
    expect(isUnregistered(badBody)).toBe(false);
    expect(isUnregistered('not json')).toBe(false);
  });
});

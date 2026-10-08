/**
 * The web's paths of `/api/remote-spaces` (web/lib/remote-paths.ts,
 * federation §8.3): every segment encoded, so an id from another install
 * stays one segment of this install's route; and only UUID ids kept.
 */
import { describe, expect, test } from 'vitest';
import { pointsHere, remoteImage } from '../../../web/lib/remote-content';
import { isUuid, remoteFilePath, remotePath, withUuidIds } from '../../../web/lib/remote-paths';

const SPACE = '6f1c2b8e-0d4a-4c8e-9f3a-2b1d0e9c8a7f';
const ROOM = '0b7e4a52-3c1d-4f6e-8a9b-1c2d3e4f5a6b';

describe('remote space paths', () => {
  test('segments are encoded one by one', () => {
    expect(remotePath(SPACE)).toBe(`/remote-spaces/${SPACE}`);
    expect(remotePath(SPACE, ['rooms', ROOM, 'messages'], 'limit=50')).toBe(`/remote-spaces/${SPACE}/rooms/${ROOM}/messages?limit=50`);
    // A hostile id cannot climb, add a query or a fragment.
    expect(remotePath(SPACE, ['rooms', '../../admin/users', 'agent'])).toBe(`/remote-spaces/${SPACE}/rooms/..%2F..%2Fadmin%2Fusers/agent`);
    expect(remotePath(SPACE, ['notes', 'x?y=1#z'])).toBe(`/remote-spaces/${SPACE}/notes/x%3Fy%3D1%23z`);
    expect(remotePath('../x', ['tasks'])).toBe('/remote-spaces/..%2Fx/tasks');
  });

  test('a file path keeps its folders, each encoded; climbing is refused', () => {
    expect(remoteFilePath(SPACE, 'docs/read me.txt')).toBe(`/remote-spaces/${SPACE}/files/docs/read%20me.txt`);
    expect(remoteFilePath(SPACE, '/a//b%2F.md')).toBe(`/remote-spaces/${SPACE}/files/a/b%252F.md`);
    expect(() => remoteFilePath(SPACE, 'docs/../../secrets')).toThrow('Not a file path');
    expect(() => remoteFilePath(SPACE, './x')).toThrow('Not a file path');
    expect(() => remoteFilePath(SPACE, '')).toThrow('Not a file path');
  });

  test('only rows with a UUID id are kept', () => {
    expect(isUuid(ROOM)).toBe(true);
    expect(isUuid('../admin')).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(withUuidIds([{ id: ROOM }, { id: '../admin' }, { id: null }, { id: `${ROOM}x` }])).toEqual([{ id: ROOM }]);
    expect(withUuidIds(undefined)).toEqual([]);
  });

  test('text from another install loads no image and links nothing of this install', () => {
    const origin = 'https://octipus.example';
    // This install: relative, protocol-relative, /api and its own origin.
    for (const url of ['/api/files/x.png', 'x.png', '//octipus.example/api/me', 'https://octipus.example/api/vault', '?x=1']) {
      expect(pointsHere(url, origin), url).toBe(true);
      expect(remoteImage(url, 'chart', origin), url).toEqual({ label: '[image: chart]', href: null });
    }
    // Elsewhere: a link, never a fetch.
    expect(pointsHere('https://tracker.example/p.gif', origin)).toBe(false);
    expect(remoteImage('https://tracker.example/p.gif', undefined, origin)).toEqual({ label: '[image]', href: 'https://tracker.example/p.gif' });
  });
});

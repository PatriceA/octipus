/**
 * Media for the person: collected per turn, linked publicly only briefly,
 * mapped for Teams.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runWithContext } from '@/core/run-context';
import { publicMedia, publicMediaUrl, resetPublicLinksForTest } from './public-links';
import { addTurnMedia, takeTurnMedia, turnMediaAttachments } from './turn-media';

afterEach(() => { resetPublicLinksForTest(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('turn media', () => {
  test('collected per run, once; nothing outside a run; duplicates and floods are dropped', () => {
    addTurnMedia({ kind: 'image', path: '/w/a.png', mimeType: 'image/png', deliver: 'attach' });
    runWithContext({ runId: 'run_a' }, () => {
      addTurnMedia({ kind: 'image', path: '/w/a.png', mimeType: 'image/png', deliver: 'attach' });
      addTurnMedia({ kind: 'image', path: '/w/a.png', mimeType: 'image/png', deliver: 'attach' });
      addTurnMedia({ kind: 'audio', path: '/w/a.mp3', mimeType: 'audio/mpeg', deliver: 'voice' });
      for (let i = 0; i < 20; i++) addTurnMedia({ kind: 'image', path: `/w/${i}.png`, mimeType: 'image/png', deliver: 'attach' });
    });
    const media = takeTurnMedia('run_a');
    expect(media).toHaveLength(12);
    expect(media.slice(0, 2).map((m) => m.path)).toEqual(['/w/a.png', '/w/a.mp3']);
    expect(takeTurnMedia('run_a')).toEqual([]);
    expect(turnMediaAttachments(media.slice(1, 2))).toEqual([{ type: 'audio', path: '/w/a.mp3', mimeType: 'audio/mpeg', filename: undefined, source: 'assistant', deliver: 'voice' }]);
  });
});

describe('public media links', () => {
  test('only with a public address; random; expire after 15 minutes', () => {
    vi.stubEnv('PUBLIC_URL', '');
    expect(publicMediaUrl(Buffer.from('x'), 'audio/mpeg', 'a.mp3')).toBeNull();
    vi.stubEnv('PUBLIC_URL', 'https://octi.example.com/');
    vi.useFakeTimers();
    const url = publicMediaUrl(Buffer.from('x'), 'audio/mpeg', 'a.mp3') as string;
    const token = url.split('/').pop() as string;
    expect(url).toBe(`https://octi.example.com/api/media/public/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(publicMedia(token)?.data).toEqual(Buffer.from('x'));
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(publicMedia(token)).toBeNull();
  });

  test('Teams: small images inline, others by public link, none without one (a line instead)', async () => {
    const { teamsAttachments } = await import('@/channels/teams/index');
    vi.stubEnv('PUBLIC_URL', '');
    const small = { type: 'image' as const, data: Buffer.from('png'), mimeType: 'image/png', filename: 'a.png' };
    const audio = { type: 'audio' as const, data: Buffer.from('mp3'), mimeType: 'audio/mpeg', filename: 'reply.mp3' };
    const none = await teamsAttachments([small, audio]);
    expect(none.attachments).toEqual([{ contentType: 'image/png', contentUrl: `data:image/png;base64,${Buffer.from('png').toString('base64')}`, name: 'a.png' }]);
    expect(none.notes[0]).toMatch(/reply\.mp3 is in the Octipus web app/);
    vi.stubEnv('PUBLIC_URL', 'https://octi.example.com');
    const linked = await teamsAttachments([audio]);
    expect(linked.attachments[0].contentUrl).toMatch(/^https:\/\/octi\.example\.com\/api\/media\/public\//);
  });
});

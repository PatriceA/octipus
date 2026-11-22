/** The streaming reply is sanitised as it grows: the same text as all at once, for a bounded amount of work per delta. */
import { expect, test } from 'vitest';
import { displayText } from '@/tui-kit';
import { sanitizeStreaming, type SettledText } from './live-text';

/** mulberry32, for a reproducible stream. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pieces whose sanitising depends on their neighbours: escape sequences
// (OSC and DCS run to their terminator), CR LF, emoji joiners, combining marks
// at a line start, surrogate pairs.
const PIECES = [
  'plain words ', 'x', '\n', '\r', '\r\n', '\t', '\x1b', '\x1b[', '\x1b[31m', 'm', '\x1b]8;;http://x', '\x07', '\x1b\\', '\x1b]0;title',
  '\x1bP1$r', '\x1b(B', '́', 'é', '👨', '‍', '👩', '\u{1f3fd}', '\ud83d', '\udc19', '🐙', '世界', '​', '️', '\x7f', '\x9b', '# heading\n',
  '```\ncode\n```\n', '- item\n',
];

test.each([1, 2, 3, 4, 5, 6, 7, 8])('split anywhere, the stream sanitises to what the whole text does (seed %i)', seed => {
  const rand = random(seed);
  let raw = '';
  let settled: SettledText | null = null;
  for (let step = 0; step < 400; step++) {
    // Deltas cut pieces at random places, as the gateway's coalescer does.
    let delta = '';
    for (let n = 1 + Math.floor(rand() * 4); n > 0; n--) delta += PIECES[Math.floor(rand() * PIECES.length)];
    const cut = Math.floor(rand() * delta.length);
    raw += delta.slice(0, cut || delta.length);
    const result = sanitizeStreaming(settled, raw);
    expect(result.text).toBe(displayText(raw));
    settled = result.settled;
  }
});

test('a reply of ~150 KB in 2,000 deltas is sanitised in linear work, not quadratic', () => {
  const line = 'The quick brown fox jumps over the lazy dog, again and again, and once more. ';
  let raw = '';
  let settled: SettledText | null = null;
  let work = 0;
  for (let n = 0; n < 2000; n++) {
    raw += n % 10 === 9 ? `${line.slice(0, 40)}\n` : line;
    const result = sanitizeStreaming(settled, raw);
    settled = result.settled;
    work += result.work;
  }
  expect(raw.length).toBeGreaterThan(145_000);
  // All at once on every delta: ~154 million characters. Incrementally: each
  // character once, plus a short unsettled tail per delta.
  expect(work).toBeLessThan(raw.length * 3);
  expect(settled?.text.length).toBeGreaterThan(raw.length - 200);
});

test('an OSC left open settles only up to where it began, then catches up once it is closed', () => {
  const opened = sanitizeStreaming(null, 'before\n\x1b]0;a title that goes on');
  expect(opened.settled.cut).toBeLessThanOrEqual('before\n'.length);
  const closed = sanitizeStreaming(opened.settled, 'before\n\x1b]0;a title that goes on\x07 and after it');
  expect(closed.text).toBe('before\n and after it');
  expect(closed.settled.cut).toBeGreaterThan('before\n\x1b]0;a title that goes on\x07'.length);
});

test('a reply that changed, not grew, is sanitised from scratch', () => {
  const first = sanitizeStreaming(null, 'one two three four');
  const changed = sanitizeStreaming(first.settled, 'ONE two');
  expect(changed.text).toBe('ONE two');
  expect(changed.work).toBe('ONE two'.length);
});

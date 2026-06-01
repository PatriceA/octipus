import { describe, expect, test } from 'bun:test';
import { compareTimelineEntries, type TimelineEntryLike, timelineEntryId } from './timeline-order';

// Regression guard for the recurring "jumping rows" bug: timeline order must be
// a pure function of the entries, independent of the order they're passed in
// (the agent map is rebuilt in a different order on every 10s poll).

const msg = (id: string, t: number): TimelineEntryLike => ({ kind: 'message', sortKey: t, data: { id } });
const agent = (id: string, t: number): TimelineEntryLike => ({ kind: 'agent', sortKey: t, data: { id } });

describe('compareTimelineEntries', () => {
  test('orders by timestamp first', () => {
    const out = [agent('a', 200), msg('m', 100)].sort(compareTimelineEntries);
    expect(out.map(timelineEntryId)).toEqual(['m:m', 'a:a']);
  });

  test('at equal timestamp, a message sorts before the agent it triggered', () => {
    const out = [agent('a', 100), msg('m', 100)].sort(compareTimelineEntries);
    expect(out.map(timelineEntryId)).toEqual(['m:m', 'a:a']);
  });

  test('equal timestamp + kind falls back to a stable id — order is input-independent', () => {
    const x = agent('xxxx', 100);
    const y = agent('yyyy', 100);
    const ascending = [x, y].sort(compareTimelineEntries).map(timelineEntryId);
    const descending = [y, x].sort(compareTimelineEntries).map(timelineEntryId);
    // Same result regardless of the order they arrived in (the poll reshuffle).
    expect(ascending).toEqual(descending);
    expect(ascending).toEqual(['a:xxxx', 'a:yyyy']);
  });

  test('a full reshuffle of equal-timestamp entries produces a single stable order', () => {
    const entries: TimelineEntryLike[] = [agent('c', 100), msg('b', 100), agent('a', 100), msg('d', 100)];
    const forward = [...entries].sort(compareTimelineEntries).map(timelineEntryId);
    const reversed = [...entries].reverse().sort(compareTimelineEntries).map(timelineEntryId);
    expect(forward).toEqual(reversed);
    // messages (kind 0) before agents (kind 1), each group id-sorted.
    expect(forward).toEqual(['m:b', 'm:d', 'a:a', 'a:c']);
  });
});

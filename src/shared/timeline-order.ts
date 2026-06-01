/**
 * Deterministic chat-timeline ordering — shared, dependency-free.
 *
 * Lives in `src/shared` (not next to the web component) for two reasons: it's
 * pure logic with no React imports, and putting it here lets the backend test
 * runner (`bun test src`) cover it — the web side has no unit-test harness, and
 * a `bun:test` file under web/ breaks `tsc --noEmit` there.
 *
 * Why this exists: the chat timeline kept suffering "jumping rows" on the 10s
 * poll. The agent map is rebuilt in a *different* order each poll
 * (`new Map(restoredAgents)` follows REST order, not live insertion order), so
 * any sort that fell back to array/Map iteration order for equal timestamps
 * would reshuffle equal-keyed entries between renders. A stable id tiebreaker
 * makes the order a pure function of the entries — reproducible regardless of
 * how the map was built or which clock stamped the timestamp.
 */

/**
 * Structural shape the comparator needs. The web component's richer
 * `TimelineEntry` union is assignable to this (it only reads the discriminant,
 * the sortKey, and a stable id field per kind).
 */
export type TimelineEntryLike =
  | { kind: 'message'; sortKey: number; data: { id: string } }
  | { kind: 'agent'; sortKey: number; data: { id: string } }
  | { kind: 'team'; sortKey: number; data: { teamId: string } }
  | { kind: 'file_changes'; sortKey: number; data: { agentId: string } };

/** Messages before the agents that respond to them; file-change summaries last. */
export const TIMELINE_KIND_ORDER: Record<TimelineEntryLike['kind'], number> = {
  message: 0,
  agent: 1,
  team: 1,
  file_changes: 2,
};

/** Stable per-entry id used as the final sort tiebreaker (uuid / swarm nodeId). */
export function timelineEntryId(e: TimelineEntryLike): string {
  switch (e.kind) {
    case 'message': return `m:${e.data.id}`;
    case 'agent': return `a:${e.data.id}`;
    case 'team': return `t:${e.data.teamId}`;
    case 'file_changes': return `f:${e.data.agentId}`;
  }
}

/** Order by timestamp, then kind, then a stable id. See module doc for the why. */
export function compareTimelineEntries(a: TimelineEntryLike, b: TimelineEntryLike): number {
  const diff = a.sortKey - b.sortKey;
  if (diff !== 0) return diff;
  const ko = TIMELINE_KIND_ORDER[a.kind] - TIMELINE_KIND_ORDER[b.kind];
  if (ko !== 0) return ko;
  const ia = timelineEntryId(a);
  const ib = timelineEntryId(b);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

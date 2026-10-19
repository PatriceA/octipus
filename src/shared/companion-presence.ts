import type { CompanionState } from './companion';

/**
 * The companion's presence across ALL of the user's conversations, as the
 * gateway reports it. The chat page animates the one open conversation; this
 * model is what the surfaces outside it follow — the tab icon and title, the
 * desktop tray icon, and system notifications — so it works while the user is
 * on another page, another tab, or another app.
 *
 * Pure: events in, state and "moments" out. A moment is something worth
 * telling the user about when they are away: a turn finished, a turn failed,
 * or the companion needs an answer.
 */

export type PresenceMomentKind = 'done' | 'needs_input' | 'failed';

export interface PresenceMoment {
  kind: PresenceMomentKind;
  /** The gateway event that caused it: one notification per event, across tabs. */
  eventId: string;
  sessionId?: string;
  /** One line about what happened, already trimmed for a notification body. */
  detail: string;
}

export interface PresenceState {
  /** Sessions with a turn in flight, and when each last showed signs of life. */
  working: Record<string, number>;
  /** Open permission requests and approvals: requestId → session. */
  pending: Record<string, string | null>;
  /** The last finished or failed turn, for the short celebratory/settling beat. */
  last: { kind: 'done' | 'failed'; at: number } | null;
  /** Last sign of any activity; long silence lets the companion doze. */
  activeAt: number;
}

/** Minimal event shape: the gateway's `GatewayEvent`, structurally. */
export interface PresenceEvent {
  id: string;
  type: string;
  sessionId?: string | null;
  payload?: unknown;
}

/** The `permission.pending` snapshot the server sends after every subscribe. */
export interface PresenceSnapshot {
  requests: Array<{ requestId: string; sessionId?: string }>;
  approvals: Array<{ requestId: string; sessionId: string }>;
}

/** How long the "done" cheer or the "interrupted" slump shows before idling. */
export const PRESENCE_BEAT_MS = 6_000;
/** A turn with no event for this long is treated as gone (a missed end event). */
export const PRESENCE_STALE_MS = 5 * 60_000;
/** Quiet this long and the companion dozes. */
export const PRESENCE_SLEEP_MS = 20 * 60_000;

const DETAIL_MAX = 140;

/** Events that mean a turn of that session is running right now. */
const WORKING_EVENTS = new Set([
  'rootAgent.status',
  'chat.delta',
  'agent.spawned',
  'agent.action',
  'agent.iteration',
  'agent.blocked',
  'agent.event',
  'pipeline.event',
  'team.started',
  'swarm.node_spawned',
]);

export function emptyPresence(now: number): PresenceState {
  return { working: {}, pending: {}, last: null, activeAt: now };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value;
  return '';
}

/** Markdown-light one-liner for a notification body. */
export function presenceDetail(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > DETAIL_MAX ? `${plain.slice(0, DETAIL_MAX - 1).trimEnd()}…` : plain;
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Apply one gateway event. */
export function reducePresence(state: PresenceState, event: PresenceEvent, now: number): { state: PresenceState; moment: PresenceMoment | null } {
  const payload = record(event.payload);
  const sessionId = event.sessionId ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined);
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';

  if (WORKING_EVENTS.has(event.type)) {
    if (!sessionId) return { state: { ...state, activeAt: now }, moment: null };
    return { state: { ...state, working: { ...state.working, [sessionId]: now }, activeAt: now }, moment: null };
  }

  switch (event.type) {
    case 'chat.response': {
      const response = record(payload.response);
      const text = firstString(response.response, response.content, response.text, payload.content);
      return {
        state: { ...state, working: sessionId ? withoutKey(state.working, sessionId) : state.working, last: { kind: 'done', at: now }, activeAt: now },
        moment: { kind: 'done', eventId: event.id, sessionId, detail: presenceDetail(text) || 'Your answer is ready.' },
      };
    }
    case 'chat.error':
      return {
        state: { ...state, working: sessionId ? withoutKey(state.working, sessionId) : state.working, last: { kind: 'failed', at: now }, activeAt: now },
        moment: { kind: 'failed', eventId: event.id, sessionId, detail: presenceDetail(firstString(payload.error)) || 'The turn stopped with an error.' },
      };
    case 'permission.request':
    case 'agent.approval_required': {
      if (!requestId || requestId in state.pending) return { state, moment: null };
      const detail = event.type === 'permission.request'
        ? `Wants to use ${firstString(payload.toolName, payload.action, payload.toolId) || 'a tool'}.`
        : presenceDetail(firstString(payload.question, payload.summary)) || 'Needs your decision.';
      return {
        state: { ...state, pending: { ...state.pending, [requestId]: sessionId ?? null }, activeAt: now },
        moment: { kind: 'needs_input', eventId: event.id, sessionId, detail },
      };
    }
    case 'permission.resolved':
    case 'approval.resolved':
      if (!requestId) return { state, moment: null };
      return { state: { ...state, pending: withoutKey(state.pending, requestId), activeAt: now }, moment: null };
    default:
      return { state, moment: null };
  }
}

/** Replace the open requests with the server's authoritative list. Never a moment: it is a resync. */
export function applyPresenceSnapshot(state: PresenceState, snapshot: PresenceSnapshot): PresenceState {
  const pending: Record<string, string | null> = {};
  for (const request of snapshot.requests) pending[request.requestId] = request.sessionId ?? null;
  for (const approval of snapshot.approvals) pending[approval.requestId] = approval.sessionId;
  return { ...state, pending };
}

/** Turns still in flight (stale ones dropped). */
export function workingSessions(state: PresenceState, now: number): string[] {
  return Object.entries(state.working).filter(([, at]) => now - at < PRESENCE_STALE_MS).map(([id]) => id);
}

/** The one state the tray and tab icon show. */
export function presenceState(state: PresenceState, now: number, connected: boolean): CompanionState {
  if (!connected) return 'interrupted';
  if (Object.keys(state.pending).length > 0) return 'waiting';
  if (workingSessions(state, now).length > 0) return 'working';
  if (state.last && now - state.last.at < PRESENCE_BEAT_MS) return state.last.kind === 'done' ? 'done' : 'interrupted';
  if (now - state.activeAt >= PRESENCE_SLEEP_MS) return 'sleeping';
  return 'idle';
}

/** When `presenceState` can next change without a new event (a beat ending, a turn going stale, dozing off). */
export function nextPresenceChange(state: PresenceState, now: number): number | null {
  const times: number[] = [];
  if (state.last && now - state.last.at < PRESENCE_BEAT_MS) times.push(state.last.at + PRESENCE_BEAT_MS);
  for (const at of Object.values(state.working)) if (now - at < PRESENCE_STALE_MS) times.push(at + PRESENCE_STALE_MS);
  if (now - state.activeAt < PRESENCE_SLEEP_MS) times.push(state.activeAt + PRESENCE_SLEEP_MS);
  return times.length ? Math.min(...times) : null;
}

/** A short status line, e.g. for the tray tooltip: "Sparkle is working on 2 conversations". */
export function presenceLabel(name: string, state: PresenceState, now: number, connected: boolean): string {
  const shown = presenceState(state, now, connected);
  const waiting = Object.keys(state.pending).length;
  const working = workingSessions(state, now).length;
  switch (shown) {
    case 'interrupted': return connected ? `${name} hit a problem` : `${name} lost the connection to the server`;
    case 'waiting': return waiting === 1 ? `${name} needs your input` : `${name} needs your input (${waiting} requests)`;
    case 'working': return working === 1 ? `${name} is working` : `${name} is working on ${working} conversations`;
    case 'done': return `${name} finished`;
    case 'sleeping': return `${name} is dozing`;
    default: return `${name} is ready`;
  }
}

/** Notification title for a moment. */
export function momentTitle(name: string, kind: PresenceMomentKind): string {
  switch (kind) {
    case 'done': return `${name} finished`;
    case 'needs_input': return `${name} needs your input`;
    case 'failed': return `${name} hit a problem`;
  }
}

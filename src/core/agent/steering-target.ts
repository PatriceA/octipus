/**
 * Which agent of a session takes steering now, or why none does. One rule for
 * every path that steers a running turn: AgentService.canSteer / steer
 * (monitor and companion wake-ups) and the gateway's chat.send / chat.steer
 * (docs/plans/orchestration-gaps-2026-11.md §3).
 *
 * Only the turn's running root is steered, never a room turn (a member's post
 * is stored once by the room, and the turn belongs to its requester, §6.3) or
 * a companion briefing. A root that is finishing (`canAcceptSteering`) or
 * cannot take input mid-turn (`acceptsMidTurnSteering`: a buffered CLI such
 * as Vibe or Antigravity, which would read guidance only with a later tool
 * response or report it unhandled at the end) is no target: its message
 * belongs in the next turn.
 */
import { getAgentManager } from '@/core/agent-manager';
import type { AgentMessage } from '@/core/types';

export interface SteerableRoot {
  getContext(): { id: string; userId: string; sessionId: string; metadata?: Record<string, unknown> };
  getStatus(): string;
  steer(message: AgentMessage): void | boolean;
  canAcceptSteering?(): boolean;
  acceptsMidTurnSteering?(): boolean;
}

export type SteeringTarget =
  | { root: SteerableRoot }
  /** `running`: a root turn runs all the same (the message would wait for it). */
  | { root: null; running: boolean; reason: string };

export function findSteeringTarget(sessionId: string): SteeringTarget {
  const running = getAgentManager().getBySession(sessionId)
    .filter((a) => a.getStatus() === 'running' && a.getContext().root === true && !a.getContext().metadata?.companionBriefing);
  const none = (reason: string): SteeringTarget => ({ root: null, running: running.length > 0, reason });
  if (!running.length) return none('No turn is running in this session.');
  const root = running.find((a) => typeof (a as Partial<SteerableRoot>).steer === 'function') as SteerableRoot | undefined;
  if (!root) return none('The running agent cannot take guidance.');
  if (root.getContext().metadata?.room) return none('A room turn is never steered.');
  if (root.canAcceptSteering?.() === false) return none('The running turn is finishing and takes no more guidance.');
  if (root.acceptsMidTurnSteering?.() === false) return none('The running agent cannot take input mid-turn.');
  return { root };
}

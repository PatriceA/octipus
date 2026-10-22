import type { ContextHookRunRecord } from '@/db/schema/context-hooks';
import type { AgentContext } from '@/core/types';

/**
 * When a hook runs. `turn_start`: before the root agent answers a message
 * (chat, a channel, a heartbeat or scheduled turn). `worker_start`: before a
 * specialist or role agent starts on its brief.
 */
export type ContextHookEvent = 'turn_start' | 'worker_start';
export const CONTEXT_HOOK_EVENTS: readonly ContextHookEvent[] = ['turn_start', 'worker_start'];

export type ContextHookKind = 'recall' | 'note' | 'notes_index';
export const CONTEXT_HOOK_KINDS: readonly ContextHookKind[] = ['recall', 'note', 'notes_index'];

export interface ContextHookDefinition {
  /** Row id for a stored hook, `builtin:<key>` for an unchanged built-in. */
  id: string;
  builtin: string | null;
  name: string;
  kind: ContextHookKind;
  events: ContextHookEvent[];
  config: Record<string, unknown>;
  enabled: boolean;
}

/** Who the agent works for and what it was asked: everything a hook may read. */
export interface ContextHookInput {
  event: ContextHookEvent;
  userId: string;
  workspaceId: string | null;
  sessionId: string;
  /** Set in a space: hooks then read the space's knowledge, never the member's personal notes. */
  space?: AgentContext['space'];
  /** The message (root turn) or the brief (worker). */
  query: string;
  /** What is left of the turn's token budget. */
  tokenBudget: number;
}

export interface ContextHookItem {
  id: string;
  sourceId: string;
  title: string;
  score: number;
}

export interface ContextHookResult {
  status: ContextHookRunRecord['status'];
  reason?: string;
  /** The block to inject; empty unless `status` is `injected`. */
  text: string;
  items: ContextHookItem[];
  tokens: number;
}

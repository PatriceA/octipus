import type { ContextHookRunRecord } from '@/db/schema/context-hooks';
import type { RepeatableGroup } from '@/core/agent/repeated-context';
import type { AgentContext } from '@/core/types';

import type { ContextHookEvent, ContextHookKind, RecallQualifiedBy } from '@/shared/context-hooks';

export type { ContextHookEvent, ContextHookKind } from '@/shared/context-hooks';
export const CONTEXT_HOOK_EVENTS: readonly ContextHookEvent[] = ['turn_start', 'worker_start'];

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
  /**
   * The previous message the user typed in this session, if any. Recall
   * searches a short message together with it (`buildRecallQuery`), so a
   * follow-up ("and for enterprise?") keeps its subject. Absent: the message
   * alone is searched.
   */
  previousMessage?: string;
  /** What is left of the turn's token budget. */
  tokenBudget: number;
}

export interface ContextHookItem {
  id: string;
  sourceId: string;
  title: string;
  /** Recall: the passage's cosine similarity to the query (0 when the query had no embedding). */
  score: number;
  /** Recall: the rules the passage qualified under (`qualifyHit`). */
  qualifiedBy?: RecallQualifiedBy[];
}

export interface ContextHookResult {
  status: ContextHookRunRecord['status'];
  reason?: string;
  /** The block to inject; empty unless `status` is `injected`. */
  text: string;
  items: ContextHookItem[];
  tokens: number;
  /** Why the hook ran in a reduced mode (recall: `embedding_failed`, keyword rules only); recorded on the run. */
  degraded?: ContextHookRunRecord['degraded'];
  /**
   * `text` as a fenced group of parts that repeat separately across turns
   * (recall: one part per passage). Absent: the block repeats as a whole.
   */
  repeatable?: RepeatableGroup;
  /**
   * Recall: what each passage showed (its excerpt, in the order of `items`)
   * and the query it was searched with. Kept only on the in-memory turn
   * handle, to tell whether the answer used a passage (`passageUsed`); never
   * stored.
   */
  shown?: { query: string; excerpts: string[] };
  /**
   * The side effects of showing this block (recall: the session's protection
   * level, the passages' access counts). `runContextHooks` runs it only for a
   * block that is injected, within the deadline and the shared budget, and
   * waits for it; a block it fails for is left out.
   */
  commit?: () => Promise<void>;
}

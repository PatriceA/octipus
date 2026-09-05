/**
 * Swarm receipts — a deterministic, framework-built audit of what a child
 * swarm node's tool calls *actually did*.
 *
 * Inspired by CodeWhale's "receipt" concept (see
 * `.octipus/codewhale-borrowed-ideas.md`): a receipt is assembled from real
 * execution records (the `ToolExecutor`'s side-effect counters), NEVER from
 * the child model's prose summary. This is house-rule #1 (fail loud) turned
 * into an artifact — a parent can detect "child claims success but wrote no
 * files / had 3 denied tool calls" without re-reading a transcript.
 *
 * Honesty discipline (also from CodeWhale): evidence we genuinely cannot
 * capture is listed in `unavailable` rather than defaulted to zero, and the
 * receipt states what it does NOT certify.
 */

import type { ChildResultStatus } from './types';

/**
 * Raw, deterministic side-effect counters accumulated by a worker's
 * `ToolExecutor` over the lifetime of a single swarm-node run. Every field
 * is a count of an event the executor actually observed — no inference.
 */
export interface SideEffectCounters {
  /** Total successful tool calls — derived as the sum of `byName`. */
  toolCalls: number;
  /** Successful file-mutating calls (FILE_CHANGE_TOOLS) — derived from `byName`. */
  filesChanged: number;
  /** Successful shell command executions (`shell__run*`) — derived from `byName`. */
  commandsRun: number;
  /** ASK-level calls that prompted a human and were approved or pending. */
  approvalsRequired: number;
  /** Approval prompts the human rejected. */
  approvalsDenied: number;
  /**
   * ASK-level calls auto-approved without a human because the worker is an
   * autonomous (non-root agent) agent. Swarm children are autonomous, so
   * this — not `approvalsRequired` — is the meaningful approval signal in a
   * child's receipt.
   */
  autoApproved: number;
  /** Calls blocked by permission policy (DENY) or a pre-tool hook. */
  permissionDenials: number;
  /** Tool executions that threw a non-cancellation error. */
  toolErrors: number;
  /**
   * Exact per-tool-name successful-execution counts. This is the single
   * incrementally-maintained tally; `toolCalls`/`filesChanged`/`commandsRun`
   * are derived from it at snapshot time so they cannot drift.
   */
  byName: Record<string, number>;
}

/**
 * Fold one counter set into another, returning a new set.
 *
 * Exists so a pipeline STAGE can be judged on what the stage did, not on what
 * its top worker happened to do personally. A worker that delegates records
 * `spawn_child` and nothing else; the shell commands and file writes live in its
 * children's receipts. Gating the stage on the parent's counters alone would
 * fail every stage that delegated — the same shape as the shell-write false
 * positive, one level up.
 *
 * `byName` sums per tool so the derived totals stay reconstructible from it.
 */
export function mergeCounters(a: SideEffectCounters, b: SideEffectCounters): SideEffectCounters {
  const byName: Record<string, number> = { ...a.byName };
  for (const [name, n] of Object.entries(b.byName)) byName[name] = (byName[name] ?? 0) + n;
  return {
    toolCalls: a.toolCalls + b.toolCalls,
    filesChanged: a.filesChanged + b.filesChanged,
    commandsRun: a.commandsRun + b.commandsRun,
    approvalsRequired: a.approvalsRequired + b.approvalsRequired,
    approvalsDenied: a.approvalsDenied + b.approvalsDenied,
    autoApproved: a.autoApproved + b.autoApproved,
    permissionDenials: a.permissionDenials + b.permissionDenials,
    toolErrors: a.toolErrors + b.toolErrors,
    byName,
  };
}

/** A fresh, zeroed counter set. */
export function emptyCounters(): SideEffectCounters {
  return {
    toolCalls: 0,
    filesChanged: 0,
    commandsRun: 0,
    approvalsRequired: 0,
    approvalsDenied: 0,
    autoApproved: 0,
    permissionDenials: 0,
    toolErrors: 0,
    byName: {},
  };
}

/**
 * What a receipt explicitly does NOT certify. Borrowed verbatim in spirit
 * from CodeWhale's "claim ceilings" — a receipt records what happened, not
 * whether it was correct or safe.
 */
export const RECEIPT_NOT_CERTIFIED = ['correctness', 'security'] as const;

/**
 * Read-only audit of one completed swarm-node run. Built by the framework
 * from `SideEffectCounters` + the run's own bookkeeping (tokens, duration,
 * terminal status). Persisted on the `swarm_nodes` row and surfaced on
 * `ChildResult.receipt` so a parent can audit a child deterministically.
 */
export interface SwarmReceipt {
  /** Schema version — bump when the shape changes. */
  schemaVersion: 1;
  nodeId: string;
  kind: 'agent' | 'subagent';
  /** Terminal status the run resolved to (mirrors ChildResult.status). */
  status: ChildResultStatus;
  sideEffects: SideEffectCounters;
  tokens: { used: number; cap: number };
  durationMs: number;
  /**
   * Evidence that could not be captured for this run (e.g. the worker did
   * not expose counters). Empty when everything was sourced from real
   * records. Never inferred — an unknown is listed here, not defaulted to 0.
   */
  unavailable: string[];
  /** Claim ceiling — what this receipt does not assert. */
  notCertified: readonly string[];
}

/**
 * Build a receipt from a run's deterministic bookkeeping.
 *
 * `counters` is `null` when the worker did not expose side-effect counters
 * (e.g. a CLI worker, or a spawn that failed before the worker ran). In that
 * case every side-effect field is reported as unavailable rather than zero —
 * "we don't know" is not the same as "nothing happened".
 */
/**
 * Render a receipt into the child-result envelope so the parent LLM audits the
 * child against ground truth (real tool-execution counters) instead of the
 * child's self-narration — "claims success but wrote no files / had denied
 * calls" is detectable without re-reading the transcript. Empty when no receipt
 * (e.g. a node with no worker run).
 *
 * Lives here rather than next to one formatter because BOTH child-result
 * surfaces need it: the await path (`swarm-tool.formatChildResult`) and the
 * detached path (`collect-tool.formatCollectedResults`). Detach is the default
 * for a root agent (`maxPendingDetached: 6`), so a receipt that renders only
 * on the await path is invisible on the flow that actually runs.
 */
export function formatReceiptBlock(receipt: SwarmReceipt | undefined): string {
  if (!receipt) return '';
  const s = receipt.sideEffects;
  const attrs =
    `toolCalls="${s.toolCalls}" filesChanged="${s.filesChanged}" ` +
    `commandsRun="${s.commandsRun}" toolErrors="${s.toolErrors}" ` +
    `denials="${s.permissionDenials}"`;
  // Fail loud: if the framework couldn't capture side effects, say so rather
  // than let zeros read as "did nothing".
  const unavailable = receipt.unavailable.length
    ? ` unavailable="${receipt.unavailable.join('; ')}"`
    : '';
  return `\n<receipt ${attrs}${unavailable}/>`;
}

export function buildReceipt(opts: {
  nodeId: string;
  kind: 'agent' | 'subagent';
  status: ChildResultStatus;
  counters: SideEffectCounters | null;
  usedTokens: number;
  tokenCap: number;
  durationMs: number;
}): SwarmReceipt {
  const unavailable: string[] = [];
  let sideEffects: SideEffectCounters;

  if (opts.counters) {
    sideEffects = opts.counters;
  } else {
    sideEffects = emptyCounters();
    unavailable.push('sideEffects: worker did not expose tool-execution counters');
  }

  return {
    schemaVersion: 1,
    nodeId: opts.nodeId,
    kind: opts.kind,
    status: opts.status,
    sideEffects,
    tokens: { used: opts.usedTokens, cap: opts.tokenCap },
    durationMs: opts.durationMs,
    unavailable,
    notCertified: RECEIPT_NOT_CERTIFIED,
  };
}

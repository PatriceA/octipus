/**
 * The post-task "distil this into a skill?" offer (docs/SESSION-LEARNING.md,
 * "Offer to distil a finished task"). Shared by the server and the web chat.
 *
 * The offer is stored on the answer it follows (`messages.metadata.skillNudge`)
 * and goes from `offered` to exactly one decision. Nothing is distilled, and
 * no model is called, until the owner accepts.
 */

/** What a client lists in `chat.send` `renders` when it can show the offer. */
export const DISTILL_NUDGE_RENDER = 'skill_nudge';

/** `accept` distils the run; `dismiss` closes this offer; `never` closes it and turns the offers off. */
export const DISTILL_NUDGE_DECISIONS = ['accept', 'dismiss', 'never'] as const;
export type DistillNudgeDecision = (typeof DISTILL_NUDGE_DECISIONS)[number];

export type DistillNudgeState = 'offered' | 'accepted' | 'dismissed';

/** The record on the answer's metadata. */
export interface DistillNudgeRecord {
  state: DistillNudgeState;
  /** The orchestrated turn (`run_<uuid>`) the offer is about. */
  runId: string;
  /** Whose run it was; the only user who may decide. */
  userId: string;
  /** When the run started (ISO): the start of the material a distillation reads. */
  startedAt: string;
  offeredAt: string;
  decidedAt?: string;
  /** Set after `accept`: the proposal the run was filed into, if one was. */
  proposalId?: string;
}

/** `GET /api/sessions/:id/distill-nudge`: the session's open offer, if any. */
export interface DistillNudgeView {
  messageId: string;
  offeredAt: string;
}

/** `POST /api/sessions/:id/distill-nudge/:messageId`: what the decision did. */
export interface DistillNudgeOutcome {
  state: Exclude<DistillNudgeState, 'offered'>;
  /** `accept`: a proposal exists for it now (filed, or merged into one). */
  distilled?: boolean;
  proposalId?: string;
  /** `accept`: the proposal's status (`pending` once you asked for it). */
  status?: 'pending' | 'candidate';
  /** A sentence for the person: what happened. */
  message: string;
  /** `never`: the offers are now off for this user. */
  optedOut?: boolean;
}

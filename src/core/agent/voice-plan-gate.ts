/**
 * Voice plan gate — the "propose, then confirm" state machine for spoken turns.
 *
 * In a live voice conversation you don't want a work request to silently spawn
 * agents mid-sentence. Instead the orchestrator proposes an approach out loud
 * and waits for your go. This holds the per-session "awaiting confirmation"
 * state and decides what each voice turn should do:
 *
 *   cold work turn            → propose  (say the approach, ask to start)
 *   pending + "yes / go"      → execute  (run the stored work)
 *   pending + "no / cancel"   → passthrough (drop the plan, just chat)
 *   pending + anything else   → propose  (treat as a refinement, re-propose)
 *   no pending, not work      → passthrough (normal conversation)
 *
 * Only voice turns hit this (the orchestrator gates on a per-session voice-mode
 * flag); typed chat keeps executing immediately.
 */

import type { AttachedFileRef } from '@/core/session-files';

export interface PendingPlan {
  /** The accumulated work request to hand to the orchestrator on confirm. */
  workMessage: string;
  /** Files the proposing turn carried, replayed with the work on confirm. */
  attachedFiles: AttachedFileRef[];
}

export type PlanAction =
  | { kind: 'propose'; workMessage: string; attachedFiles: AttachedFileRef[] }
  | { kind: 'execute'; workMessage: string; attachedFiles: AttachedFileRef[] }
  | { kind: 'passthrough' };

// An affirmation is a message made up ENTIRELY of yes-words ("yes", "go ahead",
// "yeah do it", "sure"). Requiring every word to be an affirmation word is what
// separates a confirm from a refinement that merely starts with one ("go deeper
// on pricing" fails on "deeper"; "ok but skip section 2" fails on "but").
const AFFIRM_WORDS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'sure', 'ok', 'okay', 'okey', 'k', 'go', 'ahead', 'do', 'it',
  'start', 'proceed', 'sounds', 'good', 'great', 'please', 'confirm', 'confirmed', 'absolutely',
  'correct', 'right', 'aye', 'now', 'then', 'for', 'on', "let's", 'lets', 'yea',
]);
// Cancellation — leading token is enough; extra words still mean cancel ("no,
// leave it"). Mirrors the classifier's denial set (no/stop/cancel/abort/…).
const CANCEL = /^\s*(no|nope|nah|cancel|stop|abort|reject|deny|never ?mind|forget it|don'?t|hold on|wait)\b/i;

export function isAffirmation(message: string): boolean {
  const words = message.toLowerCase().replace(/[.!,?;:]/g, '').trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => AFFIRM_WORDS.has(w));
}
export function isCancellation(message: string): boolean {
  return CANCEL.test(message);
}

export class VoicePlanGate {
  // ponytail: in-memory, per-instance, ephemeral. A pending plan is short-lived
  // conversational state — losing it on restart just means the user re-asks.
  // Move to session storage only if voice ever runs multi-instance.
  private pending = new Map<string, PendingPlan>();

  /**
   * Decide what this voice turn should do. Does NOT record the proposal — the
   * caller records only after the proposal is successfully generated (so a
   * failed generation doesn't leave a stale pending plan).
   *
   * Cancellation is checked FIRST: the classifier tags both "yes" and "no" as
   * type 'approval', so we distinguish here by wording and never treat a denial
   * as a confirm. `isWork` = classifier judged this a task that would spawn agents.
   */
  decide(sessionId: string, message: string, isWork: boolean): PlanAction {
    const pending = this.pending.get(sessionId);
    if (pending) {
      if (isCancellation(message)) {
        this.pending.delete(sessionId);
        return { kind: 'passthrough' };
      }
      if (isAffirmation(message)) {
        this.pending.delete(sessionId);
        return { kind: 'execute', workMessage: pending.workMessage, attachedFiles: pending.attachedFiles };
      }
      // Refinement ("go deeper on pricing") — fold it in, carry the files, re-propose.
      return {
        kind: 'propose',
        workMessage: `${pending.workMessage}\n\nAdditional guidance: ${message.trim()}`,
        attachedFiles: pending.attachedFiles,
      };
    }
    if (isWork) return { kind: 'propose', workMessage: message.trim(), attachedFiles: [] };
    return { kind: 'passthrough' };
  }

  /** Store the plan awaiting confirmation for this session. */
  recordProposal(sessionId: string, workMessage: string, attachedFiles: AttachedFileRef[]): void {
    this.pending.set(sessionId, { workMessage, attachedFiles });
  }

  /** Drop any pending plan (voice mode off, or session ended). */
  clear(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}

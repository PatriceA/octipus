/**
 * One prompt, built in typed tiers instead of two arrays and a regex.
 *
 * The root prompt used to be two string arrays — `staticParts` and
 * `volatileParts` — joined in order, with the cache boundary implied by a
 * regex on the date line (`VOLATILE_MARKER`). A block pushed to the wrong
 * array crossed the boundary silently, and nothing said which part of the
 * "static" prefix actually changed when the provider cache missed.
 *
 * A tier names how widely the prefix UP TO AND INCLUDING a part can be shared,
 * which is what a provider cache keys on:
 *
 *  - `install` — identical for every user of this install (no persona, no
 *    workspace, no session state before it);
 *  - `user`    — identical for this user's conversations;
 *  - `session` — identical for this conversation;
 *  - `turn`    — this turn only. It starts at the date line and rides in front
 *    of the user's message (the worker splits on `VOLATILE_MARKER`), so it is
 *    never in the cached system prefix at all.
 *
 * Tiers only ever narrow: adding a wider tier after a narrower one throws,
 * because that part could never be shared as its label claims — that is the
 * misplacement the two arrays let through. A static part that contains the
 * date-line marker throws too: the worker would split the prompt there.
 *
 * Each tier has a fingerprint and a token count (`summary`), so a cache break
 * can be traced to the tier, and the label of the part, that moved.
 *
 * A part flagged `drifts` is environment content that changes underneath the
 * conversation without anything about the conversation changing — a
 * workspace directory listing, a scanned repo suite, an AGENTS.md excerpt.
 * `freezeDrift` replays those parts from an earlier turn of the same
 * conversation (`FrozenStatic`), so a new directory on disk does not rewrite
 * the cached prefix on every following turn.
 */

import { createHash } from 'node:crypto';
import { VOLATILE_MARKER } from '@/models/providers/prompt-cache';
import { estimateTokens } from '@/utils/token-count';

export type PromptTier = 'install' | 'user' | 'session' | 'turn';
const ORDER: Record<PromptTier, number> = { install: 0, user: 1, session: 2, turn: 3 };

export interface PromptPart {
  tier: PromptTier;
  /** Stable name of the block: what a cache-break log names. */
  label: string;
  text: string;
  /** Environment content that may change mid-conversation (`freezeDrift`). */
  drifts?: boolean;
}

/** What a conversation stores to replay its drifting blocks (`SessionContext.staticPrompt`). */
export interface FrozenStatic {
  generation: string;
  checkpointId?: string;
  /** Fingerprint of the session tier's non-drifting parts and every label: its shape. */
  shape: string;
  /** label → text of the drifting parts as first sent. */
  drift: Record<string, string>;
}

export interface TierSummary {
  tier: PromptTier;
  fingerprint: string;
  tokens: number;
  labels: string[];
}

const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

export class PromptBuilder {
  private parts: PromptPart[] = [];

  /** Append a part. Empty text is dropped (a block that does not apply). */
  add(tier: PromptTier, label: string, text: string | undefined | null, opts: { drifts?: boolean } = {}): this {
    if (!text) return this;
    const last = this.parts.at(-1);
    if (last && ORDER[tier] < ORDER[last.tier]) {
      throw new Error(`PromptBuilder: "${label}" (${tier}) after "${last.label}" (${last.tier}) — a wider tier cannot follow a narrower one`);
    }
    if (tier !== 'turn' && VOLATILE_MARKER.test(text)) {
      throw new Error(`PromptBuilder: "${label}" (${tier}) contains the turn-tier date marker; the worker would split the prompt inside it`);
    }
    this.parts.push({ tier, label, text, ...(opts.drifts ? { drifts: true } : {}) });
    return this;
  }

  /** Change the text of a part already added (a hook rewriting a block). */
  replace(label: string, text: string): this {
    const part = this.parts.find((p) => p.label === label);
    if (!part) throw new Error(`PromptBuilder: no part "${label}"`);
    part.text = text;
    return this;
  }

  /** The parts of the cacheable prefix (every tier but `turn`), in order. */
  staticParts(): string[] {
    return this.parts.filter((p) => p.tier !== 'turn').map((p) => p.text);
  }

  /** The turn tier's parts, in order. */
  turnParts(): string[] {
    return this.parts.filter((p) => p.tier === 'turn').map((p) => p.text);
  }

  /** The whole system prompt: static tiers, then the turn tier. */
  build(): string {
    return this.parts.map((p) => p.text).join('');
  }

  /** Fingerprint, token count and labels per tier present. */
  summary(): TierSummary[] {
    const out: TierSummary[] = [];
    for (const tier of Object.keys(ORDER) as PromptTier[]) {
      const parts = this.parts.filter((p) => p.tier === tier);
      if (!parts.length) continue;
      const text = parts.map((p) => p.text).join('');
      out.push({ tier, fingerprint: fingerprint(text), tokens: estimateTokens(text), labels: parts.map((p) => p.label) });
    }
    return out;
  }

  /**
   * Replay the drifting session parts from `frozen` when it belongs to this
   * conversation (same generation and checkpoint) and the session tier has
   * the same shape; otherwise keep this turn's text. Returns what to store:
   * the frozen value when it applied unchanged, a fresh one otherwise.
   *
   * A clear or a checkpoint (which reset the provider cache anyway) and any
   * change to the session tier's shape — a space role, dev mode, the
   * inline-UI offer, a dropped tool group — rebuild the drifting parts too.
   */
  freezeDrift(frozen: FrozenStatic | undefined, scope: { generation: string; checkpointId?: string }): { frozen: FrozenStatic; replayed: boolean } {
    const session = this.parts.filter((p) => p.tier === 'session');
    const shape = fingerprint(JSON.stringify(session.map((p) => [p.label, p.drifts ? '' : p.text])));
    const sameConversation = frozen && frozen.generation === scope.generation && frozen.checkpointId === scope.checkpointId;
    if (sameConversation && frozen.shape === shape) {
      for (const part of session) {
        const kept = part.drifts ? frozen.drift[part.label] : undefined;
        if (kept !== undefined) part.text = kept;
      }
      return { frozen, replayed: true };
    }
    const drift: Record<string, string> = {};
    for (const part of session) if (part.drifts) drift[part.label] = part.text;
    return { frozen: { generation: scope.generation, ...(scope.checkpointId ? { checkpointId: scope.checkpointId } : {}), shape, drift }, replayed: false };
  }
}

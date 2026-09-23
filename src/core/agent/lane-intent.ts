/**
 * Which model lane serves this turn.
 *
 * Until now every task turn resolved to one binding, so putting a stronger
 * model on implementation meant paying for it on "what's the weather" too.
 * With `agents` split into `build` and `everyday` (see src/models/topics.ts)
 * the choice has to be made per request, before the turn starts.
 *
 * Before, not after, and that is the whole argument. A model routed to the
 * wrong TOOL notices and calls `list_tools` — measured, it recovers by itself.
 * A model routed to the wrong LANE notices nothing: a weak model does not stall
 * on hard work, it produces something plausible and finishes, and no downstream
 * check fires. Escalation catches a stall; it does not catch mediocrity. So the
 * decision cannot be deferred to the model that would be the victim of it.
 *
 * The classifier is reused rather than rebuilt. `classifyMessage` already
 * carries a keyword table with years of comments about the asks it steals from
 * the wrong category, and `canonicalTopic` already maps every one of those
 * categories to a lane. A second table would be a second source of truth for
 * one fact, and the copy is the one that goes stale.
 */

import { choiceOf, decide, type DecisionSite } from '@/models/decision';
import { canonicalTopic } from '@/models/topics';
import { coreLogger } from '@/utils/logger';
import type { MessageClassification } from './types';

/** Text lanes a request can be routed to. */
export type Lane = 'build' | 'verify' | 'everyday' | 'research';

const LANES: readonly string[] = ['build', 'verify', 'everyday', 'research'];

/**
 * The confidence at which the classifier's category is worth acting on.
 *
 * 0.375 is not a taste: it is `bestScore / 4` for `bestScore === 1.5`, the score
 * a confident multi-word keyword match produces, and it is the LOWEST
 * confidence `classifyMessage` ever attaches a topic to. Set at 0.4 this
 * discarded the arena's fix brief — "the unit tests in this directory fail…
 * fix ledger.py" came back `coding` at 0.38 and was thrown away, and only the
 * artefact signal below saved the routing.
 *
 * Below this the classifier attaches no topic at all, so the floor guards
 * against a CALLER passing something weaker, not against the classifier.
 */
export const LANE_CONFIDENCE_FLOOR = 0.375;

/**
 * Things in a message that mean an artefact is in play even when no keyword
 * matched: a code fence, a path with a source extension, a stack trace.
 *
 * These carry the "fail up" half of the rule. Work that leaves a file someone
 * later depends on goes to the expensive lane, because that is the failure
 * nobody sees. Everything else falls to `everyday`, where a wrong answer is
 * visible in the reply and costs a cent to redo.
 */
const ARTEFACT_SIGNAL = new RegExp(
  '```'
  + '|\\b[\\w.-]+\\.(ts|tsx|js|jsx|mjs|py|rs|go|java|kt|rb|php|cs|c|cc|cpp|h|hpp|swift|sql|sh|ya?ml|toml|ini|gradle)\\b'
  + '|(^|\\s)(src|lib|app|test|tests|packages)/'
  + '|\\bTraceback\\b|\\b\\w*(Error|Exception)\\b\\s*:'
  + '|\\bgit (diff|status|log|commit)\\b',
  'i',
);

export interface LaneChoice {
  lane: Lane;
  /** Why, for the log line — a routing decision nobody can explain is a bug. */
  reason: string;
}

/**
 * Pick the lane for a request.
 *
 * `classification` is the existing keyword classification of the same message.
 * An explicit choice by the user (a pinned model, a chosen lane) is resolved by
 * the caller BEFORE this runs and never reaches here.
 */
export function selectLane(message: string, classification?: MessageClassification): LaneChoice {
  const topic = classification?.topic;
  if (topic && (classification?.confidence ?? 0) >= LANE_CONFIDENCE_FLOOR) {
    const lane = canonicalTopic(topic);
    if (LANES.includes(lane)) {
      return { lane: lane as Lane, reason: `classified "${topic}" (${classification?.confidence.toFixed(2)})` };
    }
  }
  if (ARTEFACT_SIGNAL.test(message ?? '')) {
    return { lane: 'build', reason: 'the message names a file, a trace or a diff' };
  }
  return { lane: 'everyday', reason: 'no signal for anything dearer' };
}

/**
 * Decision-model lane routing (docs/plans/decision-models.md, site 5) — SHADOW
 * ONLY. Asked only when the keyword classifier was not confident, i.e. when
 * `selectLane` fell through to its artefact/default heuristics. Fire-and-forget
 * so a turn never waits on it; it logs agreement with the heuristic.
 * ponytail: going live means making lane selection async at both callers
 * (root-runner, model-selector) and passing `npm run eval:routing` first.
 */
const LANE_SITE: DecisionSite = { id: 'routing.lane', sensitivity: 'personal', minConfidence: 0.8 };
const LANE_CRITERIA: Record<Lane, string> = {
  build: 'implementation, architecture, debugging or code review: work that leaves an artefact (code, config, a file) someone will depend on',
  verify: 'reviewing, testing or QA-checking work that already exists',
  everyday: 'chat, lookups, classification, summaries, drafting: a quick answer whose quality is visible at a glance',
  research: 'investigation or deep research across many sources',
};

export function shadowLaneDecision(message: string, classification: MessageClassification | undefined, heuristic: LaneChoice): void {
  if (classification?.topic && (classification.confidence ?? 0) >= LANE_CONFIDENCE_FLOOR) return;
  void decide(LANE_SITE, { request: (message ?? '').slice(0, 4000) }, {
    lane: { type: 'choice', instructions: 'Which kind of work does this request ask for?', criteria: LANE_CRITERIA },
  }).then((answer) => {
    const decided = choiceOf(answer, 'lane');
    if (decided) coreLogger.info({ site: LANE_SITE.id, agreed: decided === heuristic.lane, decision: decided, heuristic: heuristic.lane }, 'decision shadow');
  });
}

/**
 * The lane a caller named, or undefined when the string is not one.
 *
 * `spawn_child`'s `topic` is free text and has always also carried things like
 * "oauth/pkce" for the topic path. Handing one of those to the model registry
 * as a lane resolves to nothing and fails the spawn, so a name that is not a
 * lane is not a routing instruction — it is a label.
 *
 * `background` is deliberately not routable here: it is the lane for memory
 * extraction and summarisation, not somewhere a parent may send its child.
 */
export function asLane(requested: string | undefined | null): Lane | undefined {
  if (!requested) return undefined;
  const canonical = canonicalTopic(requested);
  return LANES.includes(canonical) ? (canonical as Lane) : undefined;
}

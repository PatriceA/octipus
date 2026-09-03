/**
 * Single-model topic bindings — the set of text topics one general-purpose chat
 * model can serve, and a helper to produce the `topics` / `topicRoles` for
 * binding a model to all of them at once.
 *
 * Why this exists: worker topics are fail-loud — `getModelForTopic` has no
 * default fallback (only the root agent falls back). So a single-model install
 * that binds just `general` breaks the moment the router routes to any other
 * specialist (`coding`, `research`, …): the topic is unbound and the spawn
 * throws. For the "run Octipus on one small local model" scenario the one chat
 * model must serve every text topic.
 *
 * Excluded on purpose: `embedding`, `ocr`, `vision` — different model classes.
 * Binding a chat model to them would produce garbage; they stay unbound so the
 * dependent features fail loud / degrade as designed (the user adds an embedding
 * and/or vision model separately).
 */

import { TEXT_TOPIC_VALUES } from './topics';

/**
 * Every text topic a single general chat model can reasonably handle — the
 * worker role topics, root agent-direct text topics, and automated background
 * text tasks. Derived from the canonical topic registry (`TEXT_TOPIC_VALUES`)
 * so there is ONE source of truth; the vision/ocr/embedding model classes are
 * excluded there. A drift guard in the test cross-checks the role subset
 * against the live role registry.
 */
export const SINGLE_MODEL_CHAT_TOPICS = TEXT_TOPIC_VALUES;

export type SingleModelChatTopic = string;

/**
 * Build the `topics` array + `topicRoles` map that bind a model as `primary` for
 * every single-model chat topic. Pass the result straight into a model_config
 * insert/update.
 */
export function singleModelTopicBindings(): {
  topics: string[];
  topicRoles: Record<string, 'primary'>;
} {
  const topics = [...SINGLE_MODEL_CHAT_TOPICS];
  const topicRoles: Record<string, 'primary'> = {};
  for (const t of topics) topicRoles[t] = 'primary';
  return { topics, topicRoles };
}

/**
 * Canonical topic registry — the ONE source of truth for the topics the
 * orchestrator can route to. Both the backend single-model binding and the
 * Topics configuration UI (via GET /topics) derive from this list so they can
 * never drift.
 *
 * Kept as a flat literal with no DB/runtime imports so it stays light enough to
 * import from the bootstrap layer.
 *
 * Topics are MODEL LANES, not domains (docs/plans/topic-consolidation.md).
 * Domain expertise lives on experts (many, user-extensible, each assigned to a
 * lane via `experts.topic`); tool bundles live on roles. A topic answers one
 * question: "which class/cost of model serves this work?"
 *
 * `kind` partitions topics by model class:
 *   - `text`      chat-capable lanes — any general chat model can serve them.
 *   - `background` automated text tasks (memory, KB review, eval, summaries,
 *                 toolshim) — one lane, bind a cheap/local model.
 *   - `vision` / `ocr` / `embedding` — different model classes; a chat model
 *                 bound to them produces garbage, so they're excluded from the
 *                 single-model chat set.
 */
export type TopicKind = 'text' | 'background' | 'vision' | 'ocr' | 'embedding';

export interface TopicDef {
  value: string;
  label: string;
  description: string;
  kind: TopicKind;
}

export const TOPICS: readonly TopicDef[] = [
  {
    value: 'agents',
    label: 'Agents',
    description: 'All expert/worker agents — the main text lane. Every specialist (Coder, Researcher, custom experts, …) resolves its model here unless the expert pins its own model or lane.',
    kind: 'text',
  },
  {
    value: 'chat',
    label: 'Chat',
    description: 'Casual conversations and direct replies. Also preferred by the orchestrator when bound; unbound = orchestrator uses the default model.',
    kind: 'text',
  },
  {
    value: 'voice',
    label: 'Voice',
    description: 'Phone call conversations (Twilio/Telnyx/Plivo) — bind a fast model for low latency. Unbound = falls back to the default model.',
    kind: 'text',
  },
  {
    value: 'background',
    label: 'Background',
    description: 'Automated background tasks: memory extraction, knowledge-base review, LLM-as-judge evaluation, chunk summarization, tool-call translation (toolshim). Bind a cheap/local model. Unbound = these features stay off.',
    kind: 'background',
  },
  // non-text model classes
  { value: 'ocr', label: 'OCR', description: 'Text extraction from images and scanned documents', kind: 'ocr' },
  { value: 'vision', label: 'Vision', description: 'Image understanding, description, and analysis', kind: 'vision' },
  { value: 'embedding', label: 'Embedding', description: 'Vector embeddings', kind: 'embedding' },
] as const;

/**
 * Retired topic values → their canonical lane. The 16 worker-role topics and
 * the 5 per-feature background topics collapsed into `agents` / `background`
 * (docs/plans/topic-consolidation.md Phase 3); `simple` and `local` had no
 * runtime consumer and fold into `chat`.
 *
 * Aliasing (not hard removal) keeps every existing caller working: role
 * configs still carry role-named `defaultTopic`s (which double as the key for
 * role-scoped skill assignments), and external plugins/scripts may still ask
 * for old names. `canonicalTopic()` is applied at the model-registry and
 * topic-config lookup layer, so retired names transparently resolve to their
 * lane's binding.
 */
export const RETIRED_TOPIC_ALIASES: Readonly<Record<string, string>> = {
  // worker role topics → the one agents lane
  general: 'agents',
  coding: 'agents',
  research: 'agents',
  architecture: 'agents',
  review: 'agents',
  communication: 'agents',
  design: 'agents',
  devops: 'agents',
  security: 'agents',
  data: 'agents',
  ai: 'agents',
  qa: 'agents',
  finance: 'agents',
  automation: 'agents',
  pm: 'agents',
  writing: 'agents',
  // orchestrator-direct text topics with no distinct lane
  simple: 'chat',
  local: 'chat',
  // per-feature background topics → the one background lane
  memory_extraction: 'background',
  knowledge_review: 'background',
  evaluation: 'background',
  summarization: 'background',
  tool_translation: 'background',
};

/**
 * Resolve any topic value (canonical or retired) to its canonical lane.
 * Unknown values pass through unchanged — fail-loud behaviour for genuinely
 * unbound topics stays with the caller.
 */
export function canonicalTopic(topic: string): string {
  return RETIRED_TOPIC_ALIASES[topic] ?? topic;
}

/** All topic values. */
export const ALL_TOPIC_VALUES: readonly string[] = TOPICS.map((t) => t.value);

/**
 * Text topics a single general chat model can serve (text + background kinds —
 * everything except the vision/ocr/embedding model classes). This is the
 * canonical source the single-model binding derives from.
 */
export const TEXT_TOPIC_VALUES: readonly string[] = TOPICS
  .filter((t) => t.kind === 'text' || t.kind === 'background')
  .map((t) => t.value);

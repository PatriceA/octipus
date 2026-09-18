/**
 * Canonical topic registry — the ONE source of truth for the topics the
 * root agent can route to. Both the backend single-model binding and the
 * Topics configuration UI (via GET /topics) derive from this list so they can
 * never drift.
 *
 * Kept as a flat literal with no DB/runtime imports so it stays light enough to
 * import from the bootstrap layer.
 *
 * Topics are MODEL LANES, not domains (docs/plans/topic-consolidation.md).
 * Tool bundles and permissions live on roles; procedure lives in skills. A lane
 * answers one question and only one: "which class/cost of model serves this
 * work?" A lane therefore exists if and only if you would plausibly bind a
 * DIFFERENT model to it — not because the subject is different.
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
    value: 'build',
    label: 'Build',
    description: 'Implementation, architecture, debugging and code review — the work where a stronger model changes the QUALITY of the answer rather than whether one arrives. A weak model here does not stall, it ships junior work that looks finished, so nothing downstream catches it. Bind the best model you are willing to pay for, and put the mechanical steps on its executorModel.',
    kind: 'text',
  },
  {
    value: 'everyday',
    label: 'Everyday',
    description: 'Chat, lookups, classification, summaries, drafting, email triage — high volume, low stakes, and wrong answers are visible immediately. Bind something fast and cheap. Split out of the old `agents` lane, which served the coder and the weather question from one binding and so could never be upgraded for one without paying for both.',
    kind: 'text',
  },
  {
    value: 'verify',
    label: 'Verify',
    description: 'Review and QA — the one lane whose point is to be a DIFFERENT model from the one that did the work. A second opinion from the same model is not a second opinion: it shares the blind spot that produced the code. Cheaper or dearer than `build` is the operator\'s call; different is the requirement. Unbound, review falls back to whatever `build` runs.',
    kind: 'text',
  },
  {
    value: 'research',
    label: 'Research',
    description: 'Investigation and deep research — the highest-token work in the system: a researcher fans out into children that each re-send a growing context, so a single question can cost more than a day of chat. Its own lane so it can be pinned to a local or cheap model without dragging Writing down with it. Unbound = research fails loud.',
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
 * Retired topic values → their canonical lane.
 *
 * The worker-role topics collapse into the two lanes `agents` split into, on
 * the cost of being wrong: work that leaves an ARTEFACT goes to `build`, work
 * whose answer is checkable at a glance goes to `everyday`. `research` keeps
 * its own lane — it is the highest-token work in the system, and an alias once
 * made its binding unreachable. The six per-feature background topics collapse
 * into `background`.
 *
 * Aliasing (not hard removal) keeps every existing caller working: role
 * configs still carry role-named `defaultTopic`s (which double as the key for
 * role-scoped skill assignments), and external plugins/scripts may still ask
 * for old names. `canonicalTopic()` is applied at the model-registry and
 * topic-config lookup layer, so retired names transparently resolve to their
 * lane's binding.
 */
export const RETIRED_TOPIC_ALIASES: Readonly<Record<string, string>> = {
  // The lanes this split replaced. `agents` held the coder and everything else,
  // which is exactly why a strong model could not be bound to coding without
  // paying for "what's the weather" as well.
  agents: 'build',
  writing: 'everyday',
  chat: 'everyday',
  // Telephony is alive and works; `voice` was a LATENCY hint, not a feature
  // flag — "bind a fast model so a caller is not left listening to silence".
  // `everyday` is already the fast, cheap lane, so a second binding that says
  // the same thing only adds a way for the two to disagree.
  voice: 'everyday',
  // Worker role topics. The rule is the cost of being wrong: work that leaves an
  // ARTEFACT someone later depends on fails up into `build`, because a weak
  // model there ships something plausible and nothing notices. Work that
  // produces an answer you can check at a glance fails down into `everyday`.
  coding: 'build',
  architecture: 'build',
  design: 'build',
  devops: 'build',
  security: 'build',
  data: 'build',
  ai: 'build',
  // Review and QA want a different model from the one under review, not a
  // dearer one — see the `verify` lane.
  review: 'verify',
  qa: 'verify',
  finance: 'build',
  automation: 'build',
  general: 'everyday',
  communication: 'everyday',
  pm: 'everyday',
  // root agent-direct text topics with no distinct lane
  simple: 'everyday',
  local: 'everyday',
  // per-feature background topics → the one background lane
  memory_extraction: 'background',
  knowledge_review: 'background',
  evaluation: 'background',
  summarization: 'background',
  tool_translation: 'background',
  skill_distillation: 'background',
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

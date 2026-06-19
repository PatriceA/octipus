/**
 * Canonical topic registry — the ONE source of truth for the topics the
 * orchestrator can route to. Both the backend single-model binding and the
 * Topics configuration UI (via GET /topics) derive from this list so they can
 * never drift.
 *
 * Kept as a flat literal with no DB/runtime imports so it stays light enough to
 * import from the bootstrap layer.
 *
 * `kind` partitions topics by model class:
 *   - `text`      worker role topics + orchestrator-direct text topics — any
 *                 general chat model can serve them.
 *   - `background` automated text tasks (memory, KB review, eval, summaries).
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
  // worker role topics (topic === role)
  { value: 'general', label: 'General', description: 'General-purpose tasks, browser interaction', kind: 'text' },
  { value: 'coding', label: 'Coding', description: 'Code generation, shell, git', kind: 'text' },
  { value: 'research', label: 'Research', description: 'Web search, information gathering, investigation', kind: 'text' },
  { value: 'architecture', label: 'Architecture', description: 'Software architecture, requirements, system design', kind: 'text' },
  { value: 'review', label: 'Review', description: 'Code review, PR review, quality analysis', kind: 'text' },
  { value: 'communication', label: 'Communication', description: 'Email, calendar, contacts (Google/Microsoft)', kind: 'text' },
  { value: 'design', label: 'Design', description: 'UI/UX design, layout, accessibility', kind: 'text' },
  { value: 'devops', label: 'DevOps', description: 'CI/CD, Docker, infrastructure, deployment', kind: 'text' },
  { value: 'security', label: 'Security', description: 'Security analysis, threat modeling, hardening', kind: 'text' },
  { value: 'data', label: 'Data', description: 'Databases, data pipelines, SQL', kind: 'text' },
  { value: 'ai', label: 'AI/ML', description: 'Machine learning, RAG, model training', kind: 'text' },
  { value: 'qa', label: 'QA', description: 'Testing, browser testing, bug reports', kind: 'text' },
  { value: 'finance', label: 'Finance', description: 'Financial analysis, market data', kind: 'text' },
  { value: 'automation', label: 'Automation', description: 'Workflows, process orchestration', kind: 'text' },
  { value: 'pm', label: 'Project Mgmt', description: 'Project planning, tracking, coordination', kind: 'text' },
  { value: 'writing', label: 'Writing', description: 'Documentation, technical writing', kind: 'text' },
  // orchestrator-direct / capability text topics
  { value: 'chat', label: 'Chat', description: 'Casual conversations', kind: 'text' },
  { value: 'simple', label: 'Simple', description: 'Trivial single-step requests routed direct (no swarm)', kind: 'text' },
  { value: 'local', label: 'Local', description: 'Local-model-preferred lightweight tasks', kind: 'text' },
  { value: 'voice', label: 'Voice', description: 'Phone call conversations — use a fast model for low latency', kind: 'text' },
  // automated background text tasks
  { value: 'memory_extraction', label: 'Memory Extraction', description: 'Long-term memory extractor + judge. Runs per turn — bind a cheap, fast model. Unbound = memory tier stays off.', kind: 'background' },
  { value: 'knowledge_review', label: 'Knowledge Review', description: 'KB curation / review passes — bind a cheap model.', kind: 'background' },
  { value: 'evaluation', label: 'Evaluation', description: 'LLM-as-judge for eval/conformance — use a fast deterministic model', kind: 'background' },
  { value: 'summarization', label: 'Summarization', description: 'L0 abstracts for knowledge-base chunks (docs/files). Runs per chunk on import — bind a cheap/local model. Unbound = no abstracts generated.', kind: 'background' },
  { value: 'tool_translation', label: 'Tool Translation', description: 'Toolshim: converts a weak/local model’s prose-instead-of-tool-call into a valid tool call. Runs only on the tool-call failure path. Unbound = toolshim disabled.', kind: 'background' },
  // non-text model classes
  { value: 'ocr', label: 'OCR', description: 'Text extraction from images and scanned documents', kind: 'ocr' },
  { value: 'vision', label: 'Vision', description: 'Image understanding, description, and analysis', kind: 'vision' },
  { value: 'embedding', label: 'Embedding', description: 'Vector embeddings', kind: 'embedding' },
] as const;

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

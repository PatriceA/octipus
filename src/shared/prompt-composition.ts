/**
 * What a root agent's model request was made of, by category — the data the
 * web chat's Context inspector draws (docs/CONTEXT-INSPECTOR.md).
 *
 * Shared by the backend (which measures and stores it) and the web client
 * (which renders it), so neither side keeps its own copy of the shape.
 *
 * Every size is an ESTIMATE: characters / 4, the same heuristic the prompt
 * accounting uses everywhere else. Providers tokenise differently; the
 * provider-reported input of the turn's requests is returned beside it so the
 * two can be compared rather than one silently standing in for the other.
 */

/** Fixed categories, in the order the inspector stacks them. */
export const PROMPT_CATEGORIES = [
  'guardrails',
  'role',
  'delegation',
  'workspace',
  'tools',
  'skills',
  'turn',
  'conversation',
  'other',
] as const;

export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

/**
 * Where a section sits in the request. `static` text is the cacheable prefix
 * (the same every turn until something in it changes), `volatile` is rebuilt
 * for each message, `tools` is the schema block sent with every request, and
 * `history` is the conversation replayed from earlier turns.
 */
export type PromptTier = 'static' | 'volatile' | 'tools' | 'history';

export const PROMPT_CATEGORY_INFO: Record<PromptCategory, { label: string; description: string }> = {
  guardrails: {
    label: 'Guardrails & formatting',
    description: 'Fixed rules every turn starts with: the security preamble, output formatting, vault use and interactive-answer rules.',
  },
  role: {
    label: 'Role & persona',
    description: 'Who the agent is: the role prompt and your persona.',
  },
  delegation: {
    label: 'Delegation',
    description: 'When to hand work to another agent and how to brief it.',
  },
  workspace: {
    label: 'Workspace',
    description: 'Where the agent is working: the project, the repo map or folder listing, a shared space.',
  },
  tools: {
    label: 'Tool definitions',
    description: 'The JSON schemas of the tools the model can call, sent with every request.',
  },
  skills: {
    label: 'Skills',
    description: 'Skills selected for this session, loaded in full on every turn.',
  },
  turn: {
    label: 'Turn context',
    description: 'Looked up for this message: date, memories, context hooks, attachments and per-turn directives.',
  },
  conversation: {
    label: 'Conversation',
    description: 'Earlier messages, tool results and the checkpoint summary, plus your new message.',
  },
  other: {
    label: 'Other',
    description: 'Text the inspector could not attribute to a category. Shown rather than hidden so nothing is unaccounted for.',
  },
};

/** Why a section is smaller than its source, when the assembler knows. */
export type PromptSectionStatus = 'truncated' | 'capped';

export interface PromptSection {
  category: PromptCategory;
  tier: PromptTier;
  /** Short human name: "Repo map", "Long-term memory", "filesystem tools". */
  label: string;
  chars: number;
  /** Estimated: ceil(chars / 4). */
  tokens: number;
  status?: PromptSectionStatus;
  /** One line on the cap or source, e.g. "first 500 of 17,320 chars". */
  note?: string;
  /** How many items the section folds together (tools, messages). */
  count?: number;
}

export interface PromptCompositionTotals {
  tokens: number;
  /** Static tier + tool schemas: what a prompt cache can reuse between turns. */
  prefixTokens: number;
  /** Volatile tier + the new message. */
  turnTokens: number;
  /** Earlier conversation. */
  historyTokens: number;
}

/** One measured request: sizes only, no prompt text. Stored with the turn's user message. */
export interface PromptComposition {
  version: 1;
  measuredAt: string;
  role: string;
  model: string;
  /** The model's window when the registry knows it. */
  contextWindow?: number;
  estimator: 'chars/4';
  toolCount: number;
  /** Lazy discovery advertises a core set; the rest stay callable by name. */
  registeredToolCount?: number;
  sections: PromptSection[];
  totals: PromptCompositionTotals;
}

/** A section with the text the model read. Only the latest turn of a session keeps text, in memory. */
export interface PromptSectionWithText extends PromptSection {
  text?: string;
}

/** One turn on the growth chart. */
export interface PromptTurnPoint {
  messageId: string;
  at: string;
  totals: PromptCompositionTotals;
  byCategory: Partial<Record<PromptCategory, number>>;
}

/** What the provider billed for the latest request of the measured agent (cost_log). */
export interface ProviderInputUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  at: string;
}

/** `GET /api/sessions/:id/context` */
export interface SessionContextResponse {
  latest: (Omit<PromptComposition, 'sections'> & {
    messageId?: string;
    sections: PromptSectionWithText[];
    /** False after a restart, or for a turn measured in another process: sizes only. */
    textAvailable: boolean;
  }) | null;
  turns: PromptTurnPoint[];
  usage: ProviderInputUsage | null;
  /**
   * Where the latest request's window starts losing context: older tool
   * outputs are cut past `toolTrimTokens`, older history summarised past
   * `summaryTokens`. Null when the window is not known.
   */
  limits?: { toolTrimTokens: number; summaryTokens: number } | null;
}

/** Tokens per category, in PROMPT_CATEGORIES order, zero-sized categories omitted. */
export function tokensByCategory(sections: ReadonlyArray<Pick<PromptSection, 'category' | 'tokens'>>): Partial<Record<PromptCategory, number>> {
  const out: Partial<Record<PromptCategory, number>> = {};
  for (const s of sections) out[s.category] = (out[s.category] ?? 0) + s.tokens;
  return out;
}

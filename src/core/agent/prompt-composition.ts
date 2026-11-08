/**
 * Prompt composition by category — what the Context inspector shows
 * (docs/CONTEXT-INSPECTOR.md).
 *
 * `prompt-budget.ts` measures the assembled system prompt and logs it, labelled
 * by each section's first line. That answers "what is big" in a log, but a
 * label read off the text is not a stable category a client can colour, and
 * the log leaves out the two parts that are added after it measures: the
 * session's selected skills and MCP servers (agent-manager) and the
 * conversation history (loaded by the worker under the session lock).
 *
 * So the root turn's prompt is measured in three steps, each where its text
 * exists:
 *   1. the root runner tags every part it assembles with a category
 *      (`promptPart`, `splitBasePrompt` in `prompt-parts.ts`) and stages them for the session (`stageRootPrompt`);
 *   2. the agent manager adds what it appends and binds the staged prompt to
 *      the agent it spawns (`bindStagedRootPrompt`);
 *   3. the worker, holding system messages, tools and history at the moment
 *      it adds the user message, measures the whole request
 *      (`measureRootRequest`) and stores the sizes with that message.
 *
 * Text never goes to the database: the latest turn of a session keeps it in
 * memory (`recordLatestComposition`) so its owner can read what the model
 * read; older turns keep sizes only.
 */
import type { AgentMessage } from '@/core/types';
import { sectionLabel } from './prompt-budget';
import { REPEATED_CONTEXT_NOTE } from './repeated-context';
import {
  PROMPT_CATEGORIES,
  type PromptCategory,
  type PromptComposition,
  type PromptSectionStatus,
  type PromptSectionWithText,
  type PromptTier,
} from '@/shared/prompt-composition';

/** Same chars/4 heuristic as `prompt-budget.ts`; the inspector labels it an estimate. */
function estimate(chars: number): number {
  return Math.ceil(chars / 4);
}

/** A tagged piece of the assembled prompt. */
export interface PromptPart {
  tier: 'static' | 'volatile';
  category: PromptCategory;
  label: string;
  text: string;
  status?: PromptSectionStatus;
  note?: string;
}

export function promptPart(
  tier: PromptPart['tier'],
  category: PromptCategory,
  label: string,
  text: string,
  extra: { status?: PromptSectionStatus; note?: string } = {},
): PromptPart {
  return { tier, category, label, text, ...extra };
}

/**
 * Tag a turn-context block (memory, context hooks, attachments…). When the
 * labelled pieces do not add up to the block — a caller changed one without
 * the other — the block is kept whole rather than mis-attributed.
 */
export function turnContextParts(block: string, pieces: ReadonlyArray<{ label: string; text: string }> | undefined): PromptPart[] {
  if (!block) return [];
  const usable = (pieces ?? []).filter((p) => p.text);
  if (usable.length > 0 && usable.map((p) => p.text).join('') === block) {
    return usable.map((p) => promptPart('volatile', 'turn', p.label, p.text));
  }
  return [promptPart('volatile', 'turn', 'Turn context', block)];
}

/**
 * Records which category each pushed string belongs to, then resolves the
 * runner's plain `string[]` tiers into parts. A string pushed without a tag is
 * not dropped: it comes back as `other`, labelled by its first line, so a new
 * prompt block shows up in the inspector instead of silently going unaccounted.
 */
export class PromptTagger {
  private readonly byText = new Map<string, PromptPart[]>();

  /** Tag `text` and return it, so a push site reads `parts.push(tagger.tag(…))`. */
  tag(
    tier: PromptPart['tier'],
    category: PromptCategory,
    label: string,
    text: string,
    extra: { status?: PromptSectionStatus; note?: string } = {},
  ): string {
    if (text) this.byText.set(text, [promptPart(tier, category, label, text, extra)]);
    return text;
  }

  /** `text` is pushed whole but measured as `parts` (the base prompt, the turn context). */
  tagSplit(text: string, parts: PromptPart[]): string {
    if (text && parts.length > 0 && parts.map((p) => p.text).join('') === text) this.byText.set(text, parts);
    return text;
  }

  resolve(staticParts: readonly string[], volatileParts: readonly string[]): PromptPart[] {
    const pick = (tier: PromptPart['tier']) => (text: string): PromptPart[] =>
      this.byText.get(text)?.map((p) => ({ ...p, tier })) ?? [promptPart(tier, 'other', sectionLabel(text), text)];
    return [...staticParts.filter(Boolean).flatMap(pick('static')), ...volatileParts.filter(Boolean).flatMap(pick('volatile'))];
  }
}

// ── Staging: root runner → agent manager → worker ─────────────────────────

export interface StagedRootPrompt {
  parts: PromptPart[];
  role: string;
  model: string;
  contextWindow?: number;
  registeredToolCount?: number;
}

/** Keeps a lost hand-off (a spawn that failed after staging) from growing the map. */
const MAX_STAGED = 200;
const stagedBySession = new Map<string, StagedRootPrompt>();
const stagedByAgent = new Map<string, StagedRootPrompt>();

function capped<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_STAGED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** Step 1: the root runner's tagged parts for this session's next spawn. */
export function stageRootPrompt(sessionId: string, staged: StagedRootPrompt): void {
  capped(stagedBySession, sessionId, staged);
}

/**
 * Step 2: the agent manager rewrites the parts the way it rewrites the prompt
 * (module filter), adds its own sections, and moves the result from the
 * session to the agent it spawned, so a second turn cannot pick it up.
 */
export function bindStagedRootPrompt(
  sessionId: string,
  agentId: string,
  amend: { rewrite?: (text: string) => string; add?: PromptPart[] } = {},
): void {
  const staged = stagedBySession.get(sessionId);
  if (!staged) return;
  stagedBySession.delete(sessionId);
  const rewritten = amend.rewrite
    ? staged.parts.map((p) => ({ ...p, text: amend.rewrite!(p.text) }))
    : staged.parts;
  const parts = [...rewritten.filter((p) => p.text), ...(amend.add ?? []).filter((p) => p.text)];
  capped(stagedByAgent, agentId, { ...staged, parts });
}

/** Step 3: the worker takes its staged prompt, once. */
export function takeStagedRootPrompt(agentId: string): StagedRootPrompt | undefined {
  const staged = stagedByAgent.get(agentId);
  stagedByAgent.delete(agentId);
  return staged;
}

// ── Measurement ───────────────────────────────────────────────────────────

/** Tools listed one by one before the rest are folded into one row. */
const TOOLS_LISTED = 10;
/** Kept per section in memory for "what the model reads". */
const MAX_SECTION_TEXT = 100_000;
const CHECKPOINT_PREFIX = '[Conversation checkpoint]';

export interface ToolSchema {
  name: string;
  description: string;
  parameters: unknown;
}

function toolJson(t: ToolSchema): string {
  return JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters });
}

function messageChars(m: AgentMessage): number {
  return (m.content?.length ?? 0) + (m.toolCalls?.length ? JSON.stringify(m.toolCalls).length : 0);
}

function section(
  category: PromptCategory,
  tier: PromptTier,
  label: string,
  chars: number,
  extra: { text?: string; status?: PromptSectionStatus; note?: string; count?: number } = {},
): PromptSectionWithText {
  const { text, ...rest } = extra;
  return {
    category, tier, label, chars, tokens: estimate(chars), ...rest,
    ...(text !== undefined ? { text: text.length > MAX_SECTION_TEXT ? `${text.slice(0, MAX_SECTION_TEXT)}\n…` : text } : {}),
  };
}

function toolSections(tools: ReadonlyArray<ToolSchema>): PromptSectionWithText[] {
  const sized = tools.map((t) => ({ name: t.name, json: toolJson(t) })).sort((a, b) => b.json.length - a.json.length);
  const out = sized.slice(0, TOOLS_LISTED).map((t) => section('tools', 'tools', t.name, t.json.length, { text: t.json }));
  const rest = sized.slice(TOOLS_LISTED);
  if (rest.length > 0) {
    out.push(section('tools', 'tools', `${rest.length} more tools`, rest.reduce((n, t) => n + t.json.length, 0), {
      count: rest.length,
      note: rest.map((t) => t.name).join(', '),
    }));
  }
  return out;
}

function historySections(history: ReadonlyArray<AgentMessage>): PromptSectionWithText[] {
  let userChars = 0, userCount = 0, assistantChars = 0, assistantCount = 0, toolChars = 0, toolCount = 0;
  let largestTool: { name: string; chars: number } | null = null;
  const out: PromptSectionWithText[] = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    if (m.role === 'user' && m.content?.startsWith(CHECKPOINT_PREFIX)) {
      out.push(section('conversation', 'history', 'Checkpoint summary', m.content.length, { text: m.content }));
      continue;
    }
    const chars = messageChars(m);
    if (m.role === 'tool') {
      toolChars += chars; toolCount++;
      if (!largestTool || chars > largestTool.chars) largestTool = { name: m.name ?? 'tool', chars };
    } else if (m.role === 'assistant') {
      assistantChars += chars; assistantCount++;
    } else {
      userChars += chars; userCount++;
    }
  }
  if (toolCount) {
    out.push(section('conversation', 'history', 'Tool results', toolChars, {
      count: toolCount,
      ...(largestTool ? { note: `largest: ${largestTool.name}, ~${estimate(largestTool.chars).toLocaleString('en-US')} tokens` } : {}),
    }));
  }
  if (assistantCount) {
    out.push(section('conversation', 'history', 'Assistant messages and tool calls', assistantChars, { count: assistantCount }));
  }
  if (userCount) {
    out.push(section('conversation', 'history', 'Earlier user messages', userChars, {
      count: userCount,
      note: 'includes the turn context stored with each one',
    }));
  }
  return out;
}

/**
 * Measure one root request: the staged parts, the advertised tools, the
 * history the worker loaded and the user's new message. Sections come back in
 * category order.
 */
export function measureRootRequest(input: {
  staged: StagedRootPrompt;
  tools: ReadonlyArray<ToolSchema>;
  history: ReadonlyArray<AgentMessage>;
  userText: string;
  /**
   * Retrieved blocks this turn left out because an earlier message in the
   * conversation still carries them (`repeated-context.ts`), as the worker
   * trimmed them. They were not sent, so they are not counted; the note that
   * replaced them is.
   */
  omitted?: readonly string[];
  measuredAt?: Date;
}): MeasuredComposition {
  const omitted = new Set(input.omitted ?? []);
  const left = input.staged.parts.filter((p) => p.tier === 'volatile' && omitted.has(p.text.trim()));
  const staged: StagedRootPrompt = left.length === 0 ? input.staged : {
    ...input.staged,
    parts: [
      ...input.staged.parts.filter((p) => !left.includes(p)),
      promptPart('volatile', 'turn', 'Not repeated (already in the conversation)', REPEATED_CONTEXT_NOTE, { note: left.map((p) => p.label).join(', ') }),
    ],
  };
  // Staged parts largest first; tools and history keep the order their
  // builders gave (largest tools, then the folded rest; checkpoint first).
  const stagedSections = staged.parts
    .map((p) => section(p.category, p.tier, p.label, p.text.length, {
      text: p.text,
      ...(p.status ? { status: p.status } : {}),
      ...(p.note ? { note: p.note } : {}),
    }))
    .sort((a, b) => b.chars - a.chars);
  const all: PromptSectionWithText[] = [
    ...stagedSections,
    ...toolSections(input.tools),
    ...historySections(input.history),
    ...(input.userText ? [section('conversation', 'volatile', 'Your new message', input.userText.length, { text: input.userText })] : []),
  ];
  const order = (c: PromptCategory) => PROMPT_CATEGORIES.indexOf(c);
  // Stable: within a category the order above holds.
  const sections = all
    .filter((s) => s.chars > 0)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => order(a.s.category) - order(b.s.category) || a.i - b.i)
    .map(({ s }) => s);
  const sum = (pick: (s: PromptSectionWithText) => boolean) => sections.filter(pick).reduce((n, s) => n + s.tokens, 0);
  return {
    version: 1,
    measuredAt: (input.measuredAt ?? new Date()).toISOString(),
    role: staged.role,
    model: staged.model,
    ...(staged.contextWindow ? { contextWindow: staged.contextWindow } : {}),
    estimator: 'chars/4',
    toolCount: input.tools.length,
    ...(staged.registeredToolCount !== undefined ? { registeredToolCount: staged.registeredToolCount } : {}),
    sections,
    totals: {
      tokens: sum(() => true),
      prefixTokens: sum((s) => s.tier === 'static' || s.tier === 'tools'),
      turnTokens: sum((s) => s.tier === 'volatile'),
      historyTokens: sum((s) => s.tier === 'history'),
    },
  };
}

/** A measured request with each section's text, before it is stored. */
export type MeasuredComposition = Omit<PromptComposition, 'sections'> & { sections: PromptSectionWithText[] };

/** The stored form: sizes only. */
export function withoutText(composition: MeasuredComposition): PromptComposition {
  return { ...composition, sections: composition.sections.map(({ text: _text, ...s }) => s) };
}

// ── Latest turn, with text, in memory ─────────────────────────────────────

export interface LatestComposition {
  agentId: string;
  messageId?: string;
  composition: MeasuredComposition;
}

/** Text is ~100 KB per session; keep it for the sessions people are looking at. */
const MAX_LATEST = 50;
const latestBySession = new Map<string, LatestComposition>();

export function recordLatestComposition(sessionId: string, latest: LatestComposition): void {
  capped(latestBySession, sessionId, latest);
  while (latestBySession.size > MAX_LATEST) {
    const oldest = latestBySession.keys().next().value;
    if (oldest === undefined) break;
    latestBySession.delete(oldest);
  }
}

export function getLatestComposition(sessionId: string): LatestComposition | undefined {
  return latestBySession.get(sessionId);
}

/** Test helper. */
export function _resetPromptCompositionForTesting(): void {
  stagedBySession.clear();
  stagedByAgent.clear();
  latestBySession.clear();
}

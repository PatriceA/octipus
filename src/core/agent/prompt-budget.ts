/**
 * Prompt-section accounting.
 *
 * Nothing measured which block was eating a model's context. The only existing
 * signal is a whole-input estimate on the swarm path (`spawner.ts`), which says
 * "you are over the window" without saying what to cut, and per-section budgets
 * exist for only three blocks (AGENTS.md guide, memory, expert index) with no
 * visibility into the rest.
 *
 * This measures what was actually assembled. It is deliberately read-only —
 * measure before capping. A global prompt ceiling imposed without knowing the
 * distribution would truncate whichever section happens to be last, which is
 * not the same as dropping the least useful one.
 *
 * Labels are DERIVED from each section's own leading text rather than passed in
 * at every push site. That keeps the assembly code untouched and means a new
 * section shows up in the log automatically instead of silently going
 * unaccounted — the failure mode that made this necessary in the first place.
 */

import { coreLogger } from '@/utils/logger';

/** Rough token estimate. Matches the chars/4 heuristic used elsewhere. */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Token cost of the JSON tool block sent alongside the system prompt. Same
 * chars/4 heuristic; providers serialise the schemas slightly differently, so
 * this is an estimate, not a bill.
 */
export function estimateToolSchemaTokens(
  tools: Array<{ name: string; description: string; parameters: unknown }>,
): number {
  const chars = tools.reduce(
    (n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length,
    0,
  );
  return estimateTokens(chars);
}

/**
 * Derive a short, stable label from a section's leading text. Sections start
 * with a markdown heading, an ALL-CAPS lead-in, or a `---` rule; any of those
 * makes a serviceable name.
 */
export function sectionLabel(text: string): string {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return '(empty)';
  return firstLine
    .replace(/^#+\s*/, '')
    .replace(/^-+\s*/, '')
    .replace(/^\*+\s*/, '')
    .slice(0, 48);
}

export interface PromptSectionStat {
  label: string;
  chars: number;
  tokens: number;
  /** Share of the assembled prompt, 0–1, rounded to 3dp. */
  share: number;
}

/**
 * Break an assembled prompt into per-section stats, largest first.
 *
 * `buckets` maps a tier name (e.g. `static`) to the parts that were joined to
 * build it, so the caller passes the arrays it already has.
 */
export function summarizePromptSections(
  buckets: Record<string, string[]>,
): { total: { chars: number; tokens: number }; sections: PromptSectionStat[] } {
  const flat: Array<{ tier: string; text: string }> = [];
  for (const [tier, parts] of Object.entries(buckets)) {
    for (const text of parts) {
      if (text) flat.push({ tier, text });
    }
  }

  const chars = flat.reduce((n, s) => n + s.text.length, 0);
  const sections = flat
    .map(({ tier, text }) => ({
      label: `${tier}:${sectionLabel(text)}`,
      chars: text.length,
      tokens: estimateTokens(text.length),
      // Guard the divide — an all-empty assembly is degenerate but not a crash.
      share: chars > 0 ? +(text.length / chars).toFixed(3) : 0,
    }))
    .sort((a, b) => b.chars - a.chars);

  return { total: { chars, tokens: estimateTokens(chars) }, sections };
}

/**
 * Prompt size at which the breakdown is worth an `info` line. Below it the log
 * is a per-spawn diagnostic (`debug`); at or above it, it is the answer to
 * "why is this request so expensive" and must be visible at the default level.
 */
export const LARGE_PROMPT_TOKENS = 8_000;

/**
 * Log the breakdown, with the top consumer promoted into the message so a
 * `grep` answers "what is eating the prompt".
 *
 * `toolSchemaTokens` is counted into the total: the JSON tool block is sent on
 * every request and is the single largest contributor for tool-heavy roles
 * (`general` is ~12k tok of schema against a ~900 tok role prompt), so a
 * breakdown that omits it understates the real prompt by an order of magnitude.
 */
export function logPromptComposition(
  ctx: {
    role: string;
    model: string;
    isSmall?: boolean;
    contextWindow?: number;
    toolCount?: number;
    toolSchemaTokens?: number;
    /** `lazy` when only a core set was advertised; absent on the full path. */
    advertisement?: 'lazy';
    /** Tools still callable by name but not advertised. Lazy path only. */
    registeredToolCount?: number;
  },
  buckets: Record<string, string[]>,
): void {
  const { total, sections } = summarizePromptSections(buckets);
  const top = sections[0];
  const grandTotal = total.tokens + (ctx.toolSchemaTokens ?? 0);
  const log = grandTotal >= LARGE_PROMPT_TOKENS ? coreLogger.info : coreLogger.debug;
  log.call(
    coreLogger,
    {
      ...ctx,
      promptChars: total.chars,
      promptTokens: total.tokens,
      totalTokens: grandTotal,
      contextShare: ctx.contextWindow ? +(grandTotal / ctx.contextWindow).toFixed(3) : undefined,
      sections: sections.slice(0, 12),
    },
    `Prompt composition: ${grandTotal} tok (${total.tokens} text + ${ctx.toolSchemaTokens ?? 0} tool schema` +
      (ctx.advertisement === 'lazy'
        ? `, lazy: ${ctx.toolCount ?? 0} of ${ctx.registeredToolCount ?? 0} tools advertised)`
        : ')') +
      (top ? `, largest text section "${top.label}" at ${top.tokens} tok (${Math.round(top.share * 100)}%)` : ''),
  );
}

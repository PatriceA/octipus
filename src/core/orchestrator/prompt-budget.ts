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
 * Log the breakdown. `debug` level: this fires on every spawn and is a
 * diagnostic, not an event — but the top consumer is promoted into the message
 * so a `grep` over info-level logs still answers "what is eating the prompt".
 */
export function logPromptComposition(
  ctx: { role: string; model: string; isSmall?: boolean; contextWindow?: number },
  buckets: Record<string, string[]>,
): void {
  const { total, sections } = summarizePromptSections(buckets);
  const top = sections[0];
  coreLogger.debug(
    {
      ...ctx,
      promptChars: total.chars,
      promptTokens: total.tokens,
      contextShare: ctx.contextWindow ? +(total.tokens / ctx.contextWindow).toFixed(3) : undefined,
      sections: sections.slice(0, 12),
    },
    `Prompt composition: ${total.tokens} tok across ${sections.length} sections` +
      (top ? `, largest "${top.label}" at ${top.tokens} tok (${Math.round(top.share * 100)}%)` : ''),
  );
}

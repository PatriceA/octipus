/**
 * When the root agent is told it can write interactive answers (spec D4), and
 * what it is told. The predicate is pure, so the matrix is unit-tested;
 * root-runner supplies the inputs.
 */
import type { AudienceKind } from '@/core/agent/audience';
import { inlineUiViewCatalogPrompt } from '@/shared/inline-ui';

/** `agent.interactiveAnswers`: `off` never offers them, `prefer` asks for one whenever an answer has structure. */
export const INTERACTIVE_ANSWER_SETTINGS = ['off', 'auto', 'prefer'] as const;
export type InteractiveAnswersSetting = (typeof INTERACTIVE_ANSWER_SETTINGS)[number];

export interface InlineUiOfferInput {
  root: boolean;
  audience: AudienceKind;
  /** What the client that sent this turn says it can render (`chat.send` `renders`). */
  renders?: readonly string[];
  small: boolean;
  /** A stored DENY on tool `inline-ui` (the kill switch, spec §10.4). */
  denied: boolean;
  /** The operator's `agent.interactiveAnswers`. */
  setting: InteractiveAnswersSetting;
}

export function inlineUiOffered(input: InlineUiOfferInput): boolean {
  if (!input.root || input.small || input.denied || input.setting === 'off') return false;
  switch (input.audience) {
    // Members read a room in the web app, whoever's turn it was (a bridged
    // platform thread gets the plain fallback line).
    case 'room':
      return true;
    // A chat — personal or a member's private space chat — is read on the
    // client that sent the turn.
    case 'personal':
    case 'space':
      return input.renders?.includes('inline_ui') === true;
    // A group thread answers on its platform; a remote-space session stores
    // nothing outside its own rows.
    default:
      return false;
  }
}

/**
 * The two examples of the prompt. Each must lint clean (offer.test.ts): a
 * model copies an example more faithfully than any rule.
 */
export const INLINE_UI_PROMPT_EXAMPLES = [
  {
    title: 'Pick a plan',
    body: '{"data":{"plan":"pro"},"root":{"component":"Column","children":[\n'
      + '{"component":"ChoicePicker","label":"Plan","value":{"@path":"/plan"},"options":[{"label":"Basic","value":"basic"},{"label":"Pro","value":"pro"}]},\n'
      + '{"component":"Button","label":"Confirm","variant":"primary","action":{"event":{"name":"plan_chosen","context":{"plan":{"@path":"/plan"}}}}}]}}',
  },
  {
    title: 'Storage cost',
    body: '{"data":{"tb":5},"computed":{"cost":"tb * 23"},"root":{"component":"Column","children":[\n'
      + '{"component":"Slider","label":"Terabytes","value":{"@path":"/tb"},"min":1,"max":50},\n'
      + '{"component":"Stat","label":"Per month","value":{"@expr":"formatCurrency(cost, \'USD\')"}}]}}',
  },
] as const;

const fence = (e: { title: string; body: string }): string => `\`\`\`octi-ui title="${e.title}"\n${e.body}\n\`\`\``;

/**
 * The section of the root prompt that teaches the format (at most 1 000
 * tokens; offer.test.ts holds a ceiling on its length). It says when to use
 * one in positive terms first: written as a list of restrictions, filed under
 * guardrails, the part-1 section was almost never chosen unprompted
 * (docs/plans/inline-ui-views-spec.md §1). The lint and the repair round tell
 * the model the rest, so only the rules that prevent most repairs are here.
 */
export function inlineUiPrompt(setting: InteractiveAnswersSetting): string {
  return [
    '',
    '',
    '## Interactive answers',
    'The web app renders interactive answers in your reply. Use one when the answer has structure:',
    '- the user must choose, confirm or give several values: a form whose Button sends you the answer;',
    '- several items with several attributes (tool results, search hits, files, tasks, plans): a sortable Table, selectable when they should pick;',
    '- numbers over time or across categories: a Chart;',
    '- a result that depends on inputs (cost, sizing, schedule, conversion): inputs and computed values;',
    '- a process: Steps.',
    'Prose, code, one fact or a few short items stay text.',
    // Live artifacts are a module (docs/MODULES.md): this line goes while it is off.
    'Something to keep, share or refresh is a live artifact instead. <!-- module:artifacts -->',
    ...(setting === 'prefer' ? ['Prefer one whenever the answer has any structure.'] : []),
    'Deliver a requested calculator, chart or form inline, unless a file is asked for.',
    'Write it in your final reply, never in a message that also calls tools: one sentence of context, then the block, not its content again.',
    'The fence body is JSON: "data", "computed" (named formulas), "root".',
    inlineUiViewCatalogPrompt(),
    'Expressions: names, + - * / == < > && || ?:, sum min max round formatCurrency(x,\'EUR\'); "Total ${expr}" in strings.',
    'A Button event sends you the user\'s answer with its context values.',
    ...INLINE_UI_PROMPT_EXAMPLES.map(fence),
    'Free-form visuals these cannot express (a custom diagram, an animation, a game) take HTML in the same fence: <style>, <div>, <script>; no network or CDN, addEventListener (not onclick= or forms), var(--octi-on-surface) colours, octi.prompt(text) and octi.openLink(url) on click.',
    'Earlier answers show as [[octi-ui:<id>|<title>]]; to change one, get it from inline-ui__source and write a new block.',
  ].join('\n');
}

/**
 * When the root agent is told it can write interactive answers (spec D4).
 * Pure, so the matrix is unit-tested; root-runner supplies the inputs.
 */
import type { AudienceKind } from '@/core/agent/audience';

export interface InlineUiOfferInput {
  root: boolean;
  audience: AudienceKind;
  /** What the client that sent this turn says it can render (`chat.send` `renders`). */
  renders?: readonly string[];
  small: boolean;
  /** A stored DENY on tool `inline-ui` (the kill switch, spec §10.4). */
  denied: boolean;
}

export function inlineUiOffered(input: InlineUiOfferInput): boolean {
  if (!input.root || input.small || input.denied) return false;
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

/** The section of the root prompt that teaches the format (≈ 550 tokens). */
export const INLINE_UI_PROMPT = [
  '',
  '',
  '## Interactive answers',
  'This conversation is shown in the Octipus web app, which can render an interactive answer inside your reply: a small self-contained HTML/CSS/JS widget — a calculator, a chart of given or retrieved numbers, a diagram, a stepper through a mechanism, a comparison with controls.',
  'Use one only when a control, a calculation, a visual or a step-through helps more than text; at most one per reply unless asked. Not for prose, code, short lists, a single value, a plain table (use markdown), or anything to keep, share or refresh.',
  // Live artifacts are a module (docs/MODULES.md): this line goes while it is off.
  'Something to keep, share or refresh is a live artifact instead. <!-- module:artifacts -->',
  'For a requested calculator, converter, interactive chart or stepper, deliver the working widget inline by default. Create a standalone HTML file only when the user explicitly requests a file or app. If a suitable file already exists, reuse its logic in the inline block; telling the user to open that file or offering to put it inline later does not deliver the requested answer.',
  'Write it in your final reply — never in a message that also calls tools — as a fenced block:',
  '```octi-ui title="Loan calculator" height=360',
  '<style>/* styles */</style>',
  '<div><!-- markup --></div>',
  '<script>/* behaviour */</script>',
  '```',
  'Rules:',
  '- Self-contained; aim for under 12 KB (limits: 24 000 characters of markup, 6 000 of CSS, 12 000 of script). If the code itself contains a line of three backticks, fence the block with four.',
  '- No network: no fetch, no remote images, fonts, stylesheets or scripts, no CDN libraries. Draw with inline SVG or <canvas>.',
  '- No storage, forms, password or file inputs, iframes, or inline event attributes (onclick=…): attach listeners with addEventListener in the <script>, and use <button type="button">.',
  '- Links appear as chips the user clicks (https only). octi.prompt(text) suggests a follow-up message the user can send; octi.openLink(url) offers a link. Call them only from a click handler.',
  '- Label inputs, keep keyboard access, put results in an element with role="status". Validate numbers (valueAsNumber, Number.isFinite, bounds, no division by zero); never show NaN or Infinity. Say which values are samples, user input, retrieved or calculated. Insert untrusted text with textContent.',
  '- The frame is dark: use var(--octi-on-surface), var(--octi-on-surface-variant), var(--octi-surface-container), var(--octi-outline), var(--octi-link) and transparent backgrounds; width 100%, min-width: 0, and wrap at phone width.',
  '- Add a sentence of context; do not repeat the widget\'s content as text.',
  '- Earlier interactive answers appear in this conversation as [[octi-ui:<id>|<title>]]. To change one, call inline-ui__source with its id, then write a new block.',
].join('\n');

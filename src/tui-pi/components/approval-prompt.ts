/**
 * Approval overlay — the agent has asked the USER a question and is blocked
 * until it is answered.
 *
 * Distinct from `PermissionPrompt`, which asks "may this tool run?" and is
 * answered yes/no. This one comes from `request_user_approval`: the agent has
 * reached a decision point it is not entitled to take alone, and it carries a
 * summary, a question, and sometimes a list of choices.
 *
 * It exists because the request had nowhere to land. The backend emitted
 * `orchestrator.approval_required`, the protocol declared it, and the TUI had
 * no handler — so the screen showed `Waiting: running request_user_approval
 * (40.0s)` ticking upward with no prompt and no way to answer, until the turn
 * timed out. Two of four measured runs died that way.
 *
 * Numbered choices when the agent supplied them, y/n otherwise. Esc declines
 * rather than cancelling silently: the agent is BLOCKED, and a dismissed
 * overlay that answers nothing puts the run back where it started.
 */
import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import { chalk, getPalette } from '../theme/defaults';

export interface ApprovalPromptOptions {
  summary: string;
  question: string;
  /** Choices the agent offered. Empty means a yes/no decision. */
  options: string[];
  /** `approved` is false for a decline; `response` carries the chosen text. */
  onRespond: (approved: boolean, response: string) => void;
}

/** Choices are answered by number, so more than nine cannot be typed. */
const MAX_CHOICES = 9;

export class ApprovalPrompt implements Component, Focusable {
  focused = false;

  constructor(private readonly options: ApprovalPromptOptions) {}

  invalidate(): void { /* no cached state */ }

  private get choices(): string[] {
    return this.options.options.slice(0, MAX_CHOICES);
  }

  handleInput(data: string): void {
    const choices = this.choices;

    if (choices.length > 0) {
      // Digits are compared against the raw byte: `matchesKey` takes a named
      // KeyId, and '1'..'9' are not names.
      const digit = data.length === 1 ? data.charCodeAt(0) - 48 : NaN;
      if (digit >= 1 && digit <= choices.length) {
        this.options.onRespond(true, choices[digit - 1] as string);
        return;
      }
      // Enter takes the first choice — the agent lists them in its own order
      // of preference, and a prompt that cannot be answered by pressing Enter
      // is one people leave sitting there.
      if (matchesKey(data, 'enter')) {
        this.options.onRespond(true, choices[0] as string);
        return;
      }
    } else {
      if (matchesKey(data, 'y') || matchesKey(data, 'enter')) {
        this.options.onRespond(true, 'yes');
        return;
      }
      if (matchesKey(data, 'n')) {
        this.options.onRespond(false, 'no');
        return;
      }
    }

    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      // A decline, not a dismissal. The agent is waiting on an answer, and
      // closing the box without sending one leaves it waiting.
      this.options.onRespond(false, 'declined');
    }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (t: string) => chalk.hex(palette.accent)(t);
    const dim = (t: string) => chalk.hex(palette.dim)(t);
    const bold = (t: string) => chalk.bold.hex(palette.accent)(t);

    const choices = this.choices;
    const lines: string[] = [bold('? Your decision')];
    if (this.options.summary) lines.push(dim(this.options.summary));
    lines.push(this.options.question);
    for (const [i, choice] of choices.entries()) lines.push(`  ${i + 1}. ${choice}`);
    lines.push(
      dim(choices.length > 0
        ? `1-${choices.length} choose · Enter first · Esc decline`
        : 'y/Enter yes · n no · Esc decline'),
    );

    const maxInner = Math.max(1, width - 4);
    const innerWidth = Math.min(maxInner, Math.max(...lines.map((l) => visibleWidth(l))));
    const boxWidth = innerWidth + 4;

    return [
      border('┌' + '─'.repeat(boxWidth - 2) + '┐'),
      ...lines.map((text) =>
        border('│ ') + padTo(truncateToWidth(text, innerWidth), innerWidth) + border(' │'),
      ),
      border('└' + '─'.repeat(boxWidth - 2) + '┘'),
    ];
  }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  return w >= width ? text : text + ' '.repeat(width - w);
}

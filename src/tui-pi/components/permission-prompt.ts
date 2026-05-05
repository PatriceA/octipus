/**
 * Permission overlay shown when the gateway requests confirmation
 * for a tool call (write_file, bash, …). Captures focus, renders a
 * small bordered box, and calls back into the app with the user's
 * choice.
 *
 * Phase 3 ships this as a real overlay (was a chat line in Phase 1).
 * The overlay anchors `bottom-center` and uses pi-tui's focus stack
 * so the composer doesn't see y/n/Esc while the prompt is up.
 */
import { type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import { chalk, getPalette } from '../theme/defaults';

export interface PermissionPromptOptions {
  toolName: string;
  detail: string;
  onApprove: () => void;
  onDeny: () => void;
  onCancel: () => void;
}

export class PermissionPrompt implements Component, Focusable {
  focused = false;

  constructor(private readonly options: PermissionPromptOptions) {}

  invalidate(): void { /* no cached state */ }

  handleInput(data: string): void {
    if (matchesKey(data, 'y') || matchesKey(data, 'enter')) {
      this.options.onApprove();
      return;
    }
    if (matchesKey(data, 'n')) {
      this.options.onDeny();
      return;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.options.onCancel();
    }
  }

  render(width: number): string[] {
    const palette = getPalette();
    const border = (text: string) => chalk.hex(palette.warn)(text);
    const dim = (text: string) => chalk.hex(palette.dim)(text);
    const bold = (text: string) => chalk.bold.hex(palette.warn)(text);

    const header = bold('⚠ Permission required');
    const detail = this.options.detail;
    const hint = dim('y/Enter approve · n deny · Esc cancel');

    const maxInner = Math.max(1, width - 4);
    const innerWidth = Math.min(maxInner, Math.max(
      visibleWidth(header), visibleWidth(detail), visibleWidth(hint),
    ));
    const boxWidth = innerWidth + 4;
    const top    = border('┌' + '─'.repeat(boxWidth - 2) + '┐');
    const middle = (text: string) =>
      border('│ ') + padTo(truncateToWidth(text, innerWidth), innerWidth) + border(' │');
    const bottom = border('└' + '─'.repeat(boxWidth - 2) + '┘');

    return [top, middle(header), middle(detail), middle(hint), bottom];
  }
}

function padTo(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w >= width) return text;
  return text + ' '.repeat(width - w);
}

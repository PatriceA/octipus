/**
 * A yes-or-no question that cannot be answered by accident: `y` confirms,
 * Enter and Esc cancel (deleting a file, for one).
 */
import { type Component, displayLine, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@/tui-kit';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export class ConfirmPrompt implements Component {
  constructor(
    private readonly title: string,
    private readonly detail: string,
    /** What `y` does, for the keys line: `y Delete`. */
    private readonly action: string,
    private readonly choose: (confirmed: boolean) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, 'y')) this.choose(true);
    else if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'n') || matchesKey(data, 'ctrl+c')) this.choose(false);
  }

  render(width: number): string[] {
    const p = getPalette();
    return [
      chalk.bold.hex(p.warn)(displayLine(this.title)),
      ...wrapTextWithAnsi(displayLine(this.detail), Math.max(1, width)),
      chalk.hex(p.accent)(`y ${this.action} · Enter/Esc Cancel`),
    ].map(line => truncateToWidth(line, width, ''));
  }
}

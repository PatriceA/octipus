import { type Component, matchesKey, wrapTextWithAnsi, truncateToWidth } from '@mariozechner/pi-tui';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export class UnsavedPrompt implements Component {
  private error = '';
  constructor(private readonly labels: string[], private readonly choose: (choice: 'save' | 'discard' | 'cancel') => void) {}
  setError(error: string): void { this.error = error; }
  invalidate(): void {}
  handleInput(data: string): void {
    if (matchesKey(data, 's')) this.choose('save');
    else if (matchesKey(data, 'd')) this.choose('discard');
    else if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'ctrl+c')) this.choose('cancel');
  }
  render(width: number): string[] {
    const p = getPalette();
    return [chalk.bold.hex(p.warn)('Unsaved changes'),
      ...wrapTextWithAnsi(this.labels.join(', '), Math.max(1, width)).slice(0, 4),
      ...(this.error ? wrapTextWithAnsi(chalk.hex(p.error)(this.error), Math.max(1, width)) : []),
      chalk.hex(p.accent)('s Save · d Discard · Enter/Esc Cancel')].map(line => truncateToWidth(line, width, ''));
  }
}

/**
 * Asked when saving would overwrite a file that changed on disk since the
 * buffer was loaded or last saved (another editor, a formatter, the agent).
 *
 *   r — reload: replace the buffer with the file (undoable)
 *   o — overwrite: write the buffer over the file
 *   Esc / Enter — cancel: keep both as they are
 *
 * A deleted file cannot be reloaded; overwriting writes it again.
 */
import { type Component, displayLine, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@/tui-kit';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export type ExternalChangeChoice = 'reload' | 'overwrite' | 'cancel';

export class ExternalChangePrompt implements Component {
  constructor(
    private readonly label: string,
    private readonly deleted: boolean,
    private readonly choose: (choice: ExternalChangeChoice) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, 'r') && !this.deleted) this.choose('reload');
    else if (matchesKey(data, 'o')) this.choose('overwrite');
    else if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'ctrl+c')) this.choose('cancel');
  }

  render(width: number): string[] {
    const p = getPalette();
    const what = this.deleted
      ? `${displayLine(this.label)} was deleted on disk after you opened it.`
      : `${displayLine(this.label)} changed on disk after you opened or last saved it.`;
    const keys = this.deleted ? 'o Write it again · Enter/Esc Cancel' : 'r Reload from disk · o Overwrite with your version · Enter/Esc Cancel';
    return [
      chalk.bold.hex(p.warn)('File changed on disk'),
      ...wrapTextWithAnsi(what, Math.max(1, width)),
      ...wrapTextWithAnsi(chalk.hex(p.accent)(keys), Math.max(1, width)),
    ].map(line => truncateToWidth(line, width, ''));
  }
}

/**
 * Save As: a path for the buffer, relative to the project or absolute.
 *
 * Enter submits; the app checks the path and answers with an error to show
 * (`setError`) or closes the prompt. Writing over an existing file needs a
 * second Enter on the same path. Esc cancels.
 */
import { type Component, type Focusable, displayLine, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@/tui-kit';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';
import { TextField } from '@/tui-kit/text-field';

export interface SaveAsPromptOptions {
  label: string;
  initial: string;
  onSubmit: (path: string) => void;
  onCancel: () => void;
}

export class SaveAsPrompt implements Component, Focusable {
  focused = false;
  private readonly field: TextField;
  private error = '';

  constructor(private readonly options: SaveAsPromptOptions) {
    this.field = new TextField(options.initial);
  }

  get value(): string { return this.field.value; }
  setError(error: string): void { this.error = error; }
  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.options.onCancel(); return; }
    if (matchesKey(data, 'enter')) { this.options.onSubmit(this.field.value.trim()); return; }
    if (this.field.handleInput(data)) this.error = '';
  }

  render(width: number): string[] {
    const p = getPalette();
    const label = chalk.hex(p.dim)('path: ');
    return [
      chalk.bold.hex(p.accent)(`Save ${displayLine(this.options.label)} as`),
      label + this.field.render(Math.max(1, width - 6), true),
      ...(this.error ? wrapTextWithAnsi(chalk.hex(p.error)(this.error), Math.max(1, width)) : []),
      chalk.hex(p.dim)('Relative to the project, or absolute · Enter save · Esc cancel'),
    ].map(line => truncateToWidth(line, width, ''));
  }
}

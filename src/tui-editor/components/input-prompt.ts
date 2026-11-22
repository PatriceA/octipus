/**
 * A one-field question: go to line, a path for a new file, a new name.
 *
 * Enter submits the trimmed text; the app answers with an error to show
 * (`setError`) or closes the prompt. Esc cancels. The field is the shared
 * `TextField`, so paste, emoji and IME input work.
 */
import { type Component, type Focusable, displayLine, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@/tui-kit';
import { TextField } from '@/tui-kit/text-field';
import { chalk, getPalette } from '@/tui-pi/theme/defaults';

export interface InputPromptOptions {
  title: string;
  /** The label in front of the field (`line: `, `path: `). */
  label: string;
  hint: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export class InputPrompt implements Component, Focusable {
  focused = false;
  private readonly field: TextField;
  private error = '';

  constructor(private readonly options: InputPromptOptions) {
    this.field = new TextField(options.initial ?? '');
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
    const label = chalk.hex(p.dim)(this.options.label);
    return [
      chalk.bold.hex(p.accent)(displayLine(this.options.title)),
      label + this.field.render(Math.max(1, width - this.options.label.length), true),
      ...(this.error ? wrapTextWithAnsi(chalk.hex(p.error)(this.error), Math.max(1, width)) : []),
      chalk.hex(p.dim)(this.options.hint),
    ].map(line => truncateToWidth(line, width, ''));
  }
}

/** `N` or `N:C` (1-based) as a buffer position, or why not. */
export function parseLineTarget(input: string, lineCount: number): { line: number; col: number } | { error: string } {
  const match = /^(\d+)(?:[:,](\d+))?$/.exec(input.trim());
  if (!match) return { error: 'Type a line number, or line:column.' };
  const line = Number(match[1]);
  if (line < 1 || line > lineCount) return { error: `There are ${lineCount} line${lineCount === 1 ? '' : 's'}; type 1 to ${lineCount}.` };
  return { line: line - 1, col: match[2] ? Math.max(0, Number(match[2]) - 1) : 0 };
}

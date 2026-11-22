/**
 * What the Tab key inserts: whatever the file already indents with.
 *
 * A file indented with tabs gets a tab. A file indented with spaces gets its
 * step — the most common increase in leading spaces from one indented line
 * to the next deeper one (2, 4, 8, …). A file with no indentation to go by
 * gets two spaces.
 */
export const DEFAULT_INDENT = '  ';

export function detectIndent(text: string): string {
  let tabs = 0;
  let spaces = 0;
  const steps = new Map<number, number>();
  let previous = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (lead.startsWith('\t')) { tabs++; continue; }
    const width = lead.length;
    if (width > 0) spaces++;
    // Block comments continue with " * "; an odd step is alignment, not indentation.
    const step = width - previous;
    if (step >= 2 && step <= 8 && !line.trimStart().startsWith('*')) steps.set(step, (steps.get(step) ?? 0) + 1);
    previous = width;
  }
  if (tabs > spaces) return '\t';
  let best = 0;
  let count = 0;
  for (const [step, n] of steps) if (n > count || (n === count && step < best)) { best = step; count = n; }
  return best > 0 ? ' '.repeat(best) : DEFAULT_INDENT;
}

/** The spaces from `cell` to the next multiple of `indent`'s width, or the tab itself. */
export function indentAt(indent: string, cell: number): string {
  if (indent === '\t') return '\t';
  const unit = indent.length;
  return ' '.repeat(unit - (cell % unit));
}

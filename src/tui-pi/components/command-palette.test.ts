import { describe, expect, test } from 'bun:test';
import type { SelectItem } from '@mariozechner/pi-tui';
import { CommandPalette } from './command-palette';

const ITEMS: SelectItem[] = [
  { value: 'help',    label: '/help',    description: 'List commands' },
  { value: 'expert',  label: '/expert',  description: 'Switch expert' },
  { value: 'compact', label: '/compact', description: 'Compact context' },
  { value: 'quit',    label: '/quit',    description: 'Quit the TUI' },
];

function makePalette() {
  let selected: string | null = null;
  let cancelled = false;
  const palette = new CommandPalette({
    items: ITEMS,
    onCommand: (name) => { selected = name; },
    onCancel:  ()     => { cancelled = true; },
  });
  return { palette, get selected() { return selected; }, get cancelled() { return cancelled; } };
}

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('CommandPalette', () => {
  test('default item set comes from OCTIPUS_SLASH_COMMANDS when none supplied', () => {
    const palette = new CommandPalette({ onCommand: () => {}, onCancel: () => {} });
    const text = palette.render(80).map(strip).join('\n');
    expect(text).toContain('/help');
  });

  test('Escape cancels', () => {
    const ctx = makePalette();
    ctx.palette.handleInput('\x1b');
    expect(ctx.cancelled).toBe(true);
  });

  test('Backspace on empty filter cancels', () => {
    const ctx = makePalette();
    ctx.palette.handleInput('\x7f');
    expect(ctx.cancelled).toBe(true);
  });

  test('Backspace shrinks the filter when non-empty', () => {
    const ctx = makePalette();
    ctx.palette.handleInput('e');
    ctx.palette.handleInput('x');
    expect(ctx.palette.getFilter()).toBe('ex');
    ctx.palette.handleInput('\x7f');
    expect(ctx.palette.getFilter()).toBe('e');
    expect(ctx.cancelled).toBe(false);
  });

  test('printable characters extend the filter', () => {
    const ctx = makePalette();
    for (const c of 'help') ctx.palette.handleInput(c);
    expect(ctx.palette.getFilter()).toBe('help');
  });

  test('non-printable chars do not extend filter', () => {
    const ctx = makePalette();
    ctx.palette.handleInput(' ');
    expect(ctx.palette.getFilter()).toBe('');
  });

  test('Enter selects the highlighted item', () => {
    const ctx = makePalette();
    ctx.palette.handleInput('\r');
    expect(ctx.selected).toBe('help'); // first item by default
  });

  test('renders inside a bordered box that respects viewport width', () => {
    const ctx = makePalette();
    const lines = ctx.palette.render(40).map(strip);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[lines.length - 1].startsWith('└')).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';
import { ExternalChangePrompt, type ExternalChangeChoice } from './external-change-prompt';
import { SaveAsPrompt } from './save-as-prompt';
import { UnsavedPrompt } from './unsaved-prompt';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07/g, '');

describe('UnsavedPrompt', () => {
  test('s saves, d discards; Enter, Esc and Ctrl+C cancel', () => {
    const choices: string[] = [];
    const prompt = new UnsavedPrompt(['a.ts', 'b.ts'], (c) => choices.push(c));
    for (const key of ['s', 'd', '\r', '\x1b', '\x03', 'x']) prompt.handleInput(key);
    expect(choices).toEqual(['save', 'discard', 'cancel', 'cancel', 'cancel']);
  });

  test('names the buffers, shows an error, stays inside its width', () => {
    const prompt = new UnsavedPrompt(['a.ts', 'b.ts'], () => {});
    prompt.setError('Save failed: permission denied.');
    const lines = prompt.render(30).map(strip);
    expect(lines.join('\n')).toContain('a.ts, b.ts');
    expect(lines.join('\n')).toContain('permission');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
  });
});

describe('ExternalChangePrompt', () => {
  test('r reloads, o overwrites, Enter and Esc cancel', () => {
    const choices: ExternalChangeChoice[] = [];
    const prompt = new ExternalChangePrompt('a.ts', false, (c) => choices.push(c));
    for (const key of ['r', 'o', '\r', '\x1b']) prompt.handleInput(key);
    expect(choices).toEqual(['reload', 'overwrite', 'cancel', 'cancel']);
    expect(prompt.render(80).map(strip).join(' ')).toContain('changed on disk');
  });

  test('a deleted file cannot be reloaded', () => {
    const choices: ExternalChangeChoice[] = [];
    const prompt = new ExternalChangePrompt('a.ts', true, (c) => choices.push(c));
    prompt.handleInput('r');
    expect(choices).toEqual([]);
    expect(prompt.render(80).map(strip).join(' ')).toContain('was deleted');
  });
});

describe('SaveAsPrompt', () => {
  test('starts with the given path, takes edits and a paste, submits the trimmed path', () => {
    let submitted = '';
    const prompt = new SaveAsPrompt({ label: 'Scratch 1', initial: 'notes', onSubmit: (p) => { submitted = p; }, onCancel: () => {} });
    prompt.handleInput('\x1b[200~/todo.md \x1b[201~');
    prompt.handleInput('\r');
    expect(submitted).toBe('notes/todo.md');
  });

  test('shows the error the app returns, until the path is edited; Esc cancels', () => {
    let cancelled = false;
    const prompt = new SaveAsPrompt({ label: 'x', initial: '', onSubmit: () => {}, onCancel: () => { cancelled = true; } });
    prompt.setError('notes.md already exists. Press Enter again to replace it.');
    expect(prompt.render(80).map(strip).join('\n')).toContain('already exists');
    prompt.handleInput('a');
    expect(prompt.render(80).map(strip).join('\n')).not.toContain('already exists');
    prompt.handleInput('\x1b');
    expect(cancelled).toBe(true);
  });
});

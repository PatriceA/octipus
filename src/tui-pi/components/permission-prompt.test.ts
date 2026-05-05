import { describe, expect, test } from 'bun:test';
import { PermissionPrompt } from './permission-prompt';

interface Recorded {
  approve: number;
  deny: number;
  cancel: number;
}

function makePrompt(extra?: Partial<{ toolName: string; detail: string }>) {
  const recorded: Recorded = { approve: 0, deny: 0, cancel: 0 };
  const prompt = new PermissionPrompt({
    toolName: extra?.toolName ?? 'write_file',
    detail: extra?.detail ?? 'write_file → /tmp/x',
    onApprove: () => { recorded.approve++; },
    onDeny:    () => { recorded.deny++; },
    onCancel:  () => { recorded.cancel++; },
  });
  return { prompt, recorded };
}

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('PermissionPrompt', () => {
  test('renders header, detail, and hint inside a bordered box', () => {
    const { prompt } = makePrompt({ detail: 'write_file → /tmp/x' });
    const lines = prompt.render(60).map(strip);
    expect(lines.length).toBe(5);
    expect(lines[0].startsWith('┌') && lines[0].endsWith('┐')).toBe(true);
    expect(lines[1]).toContain('Permission required');
    expect(lines[2]).toContain('write_file → /tmp/x');
    expect(lines[3]).toContain('y/Enter approve');
    expect(lines[3]).toContain('Esc cancel');
    expect(lines[4].startsWith('└') && lines[4].endsWith('┘')).toBe(true);
  });

  test('y key approves', () => {
    const { prompt, recorded } = makePrompt();
    prompt.handleInput('y');
    expect(recorded.approve).toBe(1);
    expect(recorded.deny).toBe(0);
  });

  test('Enter approves', () => {
    const { prompt, recorded } = makePrompt();
    prompt.handleInput('\r');
    expect(recorded.approve).toBe(1);
  });

  test('n key denies', () => {
    const { prompt, recorded } = makePrompt();
    prompt.handleInput('n');
    expect(recorded.deny).toBe(1);
    expect(recorded.approve).toBe(0);
  });

  test('Escape cancels', () => {
    const { prompt, recorded } = makePrompt();
    prompt.handleInput('\x1b');
    expect(recorded.cancel).toBe(1);
  });

  test('ignores unrelated keys', () => {
    const { prompt, recorded } = makePrompt();
    prompt.handleInput('a');
    prompt.handleInput('z');
    expect(recorded).toEqual({ approve: 0, deny: 0, cancel: 0 });
  });

  test('truncates overly long details to fit width', () => {
    const long = 'x'.repeat(200);
    const { prompt } = makePrompt({ detail: long });
    const lines = prompt.render(40).map(strip);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
  });
});

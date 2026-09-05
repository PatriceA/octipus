/**
 * The sign-in overlay. The password must never reach the screen — that is the
 * whole reason this is a prompt and not `/login <user> <password>`.
 */
import { describe, expect, test, vi } from 'vitest';
import { LoginPrompt } from './login-prompt';

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');
const type = (prompt: LoginPrompt, text: string) => { for (const ch of text) prompt.handleInput(ch); };
const screen = (prompt: LoginPrompt) => prompt.render(60).map(strip).join('\n');

describe('LoginPrompt', () => {
  test('masks the password and never renders it', () => {
    const prompt = new LoginPrompt({ onSubmit: () => {}, onCancel: () => {} });
    type(prompt, 'patrice');
    prompt.handleInput('\t');
    type(prompt, 'hunter2');
    const out = screen(prompt);
    expect(out).toContain('patrice');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('•••••••');
  });

  test('Enter advances then submits the collected credentials', () => {
    const onSubmit = vi.fn();
    const prompt = new LoginPrompt({ onSubmit, onCancel: () => {} });
    type(prompt, 'patrice');
    prompt.handleInput('\r');
    type(prompt, 'hunter2');
    prompt.handleInput('\r');
    expect(onSubmit).toHaveBeenCalledWith({ username: 'patrice', password: 'hunter2', totpCode: undefined });
  });

  test('refuses to submit an empty form', () => {
    const onSubmit = vi.fn();
    const prompt = new LoginPrompt({ onSubmit, onCancel: () => {} });
    prompt.handleInput('\r');
    prompt.handleInput('\r');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen(prompt)).toContain('required');
  });

  test('a TOTP challenge adds the field and keeps the typed credentials', () => {
    const onSubmit = vi.fn();
    const prompt = new LoginPrompt({ onSubmit, onCancel: () => {} });
    type(prompt, 'patrice');
    prompt.handleInput('\t');
    type(prompt, 'hunter2');
    prompt.handleInput('\r');
    prompt.setError('TOTP code required', { totpRequired: true });
    type(prompt, '123456');
    prompt.handleInput('\r');
    expect(onSubmit).toHaveBeenLastCalledWith({ username: 'patrice', password: 'hunter2', totpCode: '123456' });
  });

  test('input is ignored while a submit is in flight, so Enter cannot double-submit', () => {
    const onSubmit = vi.fn();
    const prompt = new LoginPrompt({ username: 'patrice', onSubmit, onCancel: () => {} });
    type(prompt, 'hunter2');
    prompt.handleInput('\r');
    prompt.handleInput('\r');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test('escape cancels', () => {
    const onCancel = vi.fn();
    const prompt = new LoginPrompt({ onSubmit: () => {}, onCancel });
    prompt.handleInput('\x1b');
    expect(onCancel).toHaveBeenCalled();
  });

  test('arrow-key escape sequences do not land in a field as text', () => {
    const prompt = new LoginPrompt({ username: 'patrice', onSubmit: () => {}, onCancel: () => {} });
    prompt.handleInput('\x1b[C'); // right arrow
    expect(screen(prompt)).toContain('pass');
    expect(screen(prompt)).not.toContain('[C');
  });
});

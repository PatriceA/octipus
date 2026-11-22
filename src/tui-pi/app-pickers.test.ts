/** `/sessions`, `/resume` and `/skills` alone open a picker; Ctrl+R picks from input history. */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Component, Container, TUI } from '@/tui-kit';
import { OctipusTuiApp } from './app';
import { Composer } from './components/composer';
import type { AgentSessionEvent } from './gateway-adapter';
import { installOctipusKeybindings } from './keybindings';
import { parseSkillList, skillCommand } from './pickers';

const gateway = vi.hoisted(() => ({
  listener: (_event: AgentSessionEvent) => {},
  sendCommand: vi.fn((..._args: unknown[]) => true),
  sendChat: vi.fn((..._args: unknown[]) => true),
  getSessionId: () => undefined as string | null | undefined,
}));
vi.mock('./gateway-adapter', () => ({ GatewayAdapter: class {
  constructor(options: { getSessionId: () => string }) { gateway.getSessionId = options.getSessionId; }
  on(listener: (event: AgentSessionEvent) => void) { gateway.listener = listener; }
  sendCommand = gateway.sendCommand;
  sendChat = gateway.sendChat;
  stopAgent() {}
  getWorkspace() { return null; }
  isConnected() { return true; }
  disconnect() {}
} }));
vi.mock('@/core/gateway/cli-session', () => ({ readCliSession: () => null, clearCliSession: () => {} }));

const strip = (lines: readonly string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

function mount() {
  let root!: Container;
  let input: (data: string) => unknown = () => undefined;
  const overlays: Component[] = [];
  const tui = {
    addChild: (child: Container) => { root = child; }, setFocus: vi.fn(), requestRender: vi.fn(),
    hasOverlay: () => overlays.length > 0, terminal: { rows: 30, columns: 100 },
    addInputListener: (fn: (data: string) => unknown) => { input = fn; },
    showOverlay: (component: Component) => {
      overlays.push(component);
      return { hide: () => { overlays.splice(overlays.indexOf(component), 1); }, focus() {}, setHidden() {}, isHidden: () => false, unfocus() {}, isFocused: () => true, getBounds: () => undefined };
    },
  } as unknown as TUI;
  const app = new OctipusTuiApp(tui, {});
  const composer = root.children.find((c) => c instanceof Composer) as Composer;
  return {
    app, composer, overlays,
    submit: (text: string) => composer.onSubmit?.(text),
    picker: () => strip(overlays.at(-1)?.render(90) ?? []),
    type: (text: string) => { for (const c of text) overlays.at(-1)?.handleInput?.(c); },
    press: (data: string) => overlays.at(-1)?.handleInput?.(data),
    key: (data: string) => input(data),
  };
}

beforeEach(() => { gateway.sendCommand.mockClear(); gateway.sendChat.mockClear(); installOctipusKeybindings({}); });

const SESSIONS = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000000', title: 'Fix the parser', updatedAt: '2026-11-20T10:00:00.000Z', messages: 12, channel: 'tui' },
  { id: 'bbbbbbbb-0000-4000-8000-000000000000', title: 'Plan the release', updatedAt: '2026-11-21T09:30:00.000Z', messages: 4, channel: 'web' },
];

describe('session picker', () => {
  test('/sessions alone opens it at once, fills it from the gateway, and Enter resumes the choice', async () => {
    const t = mount();
    t.submit('/sessions');
    expect(gateway.sendCommand).toHaveBeenCalledWith('sessions');
    expect(t.picker()).toContain('Loading sessions…');
    gateway.listener({ kind: 'command.result', name: 'sessions', result: 'text', data: SESSIONS });
    expect(t.picker()).toContain('Sessions 2/2');
    t.type('release');
    expect(t.picker()).toContain('› Plan the release');
    expect(t.picker()).toContain('Session bbbbbbbb-0000-4000-8000-000000000000');
    t.press('\r');
    expect(t.overlays).toHaveLength(0);
    expect(gateway.getSessionId()).toBe(SESSIONS[1]?.id);
    expect(gateway.sendCommand).toHaveBeenLastCalledWith('history');
    await t.app.stop();
  });

  test('/resume alone opens the same picker; /resume <n> and /sessions list keep their text forms', async () => {
    const t = mount();
    t.submit('/resume');
    expect(t.picker()).toContain('Sessions');
    t.press('\x1b');
    expect(t.overlays).toHaveLength(0);
    t.submit('/sessions list');
    gateway.listener({ kind: 'command.result', name: 'sessions', result: ' 1  aaaaaaaa  Fix the parser', data: SESSIONS });
    expect(t.overlays).toHaveLength(0);
    t.submit('/resume 1');
    expect(gateway.getSessionId()).toBe(SESSIONS[0]?.id);
    await t.app.stop();
  });

  test('a refused list says why inside the picker', async () => {
    const t = mount();
    t.submit('/sessions');
    gateway.listener({ kind: 'command.result', name: 'sessions', result: null, error: 'Not signed in' });
    expect(t.picker()).toContain('Could not load: Not signed in');
    await t.app.stop();
  });
});

describe('skill picker', () => {
  const LIST = 'Skills: /skills [list] | …\nAlways is your default.\n\nresearch-notes — Research notes [automatic]\ntech-writing — Technical Writing [always]\nold-skill — unavailable [session]';

  test('reads the rows of the gateway text', () => {
    expect(parseSkillList(LIST)).toEqual({ rows: [
      { id: 'research-notes', name: 'Research notes', mode: 'automatic', available: true },
      { id: 'tech-writing', name: 'Technical Writing', mode: 'always', available: true },
      { id: 'old-skill', name: 'unavailable', mode: 'session', available: false },
    ] });
    expect(parseSkillList('Skills: help\n\nNo skills available.')).toEqual({ rows: [] });
    expect(parseSkillList('Something else entirely')).toEqual({ unreadable: 'Something else entirely' });
    expect(skillCommand({ id: 'x', name: 'X', mode: 'always', available: true }, 'automatic')).toBe('x auto');
  });

  test('/skills alone: pick a skill, then how it is used; the choice goes to the gateway as /skills <id> <mode>', async () => {
    const t = mount();
    t.submit('/skills');
    expect(gateway.sendCommand).toHaveBeenCalledWith('skills');
    gateway.listener({ kind: 'command.result', name: 'skills', result: LIST });
    t.type('writing');
    expect(t.picker()).toContain('› Technical Writing');
    t.press('\r');
    expect(t.picker()).toContain('How to use: Technical Writing');
    t.press('\x1b[B'); t.press('\x1b[B'); // This session
    t.press('\r');
    expect(gateway.sendCommand).toHaveBeenLastCalledWith('skills', { value: 'tech-writing session' });
    expect(t.overlays).toHaveLength(0);
    await t.app.stop();
  });

  test('/skills with arguments still goes straight to the gateway', async () => {
    const t = mount();
    t.submit('/skills Technical Writing session');
    expect(gateway.sendCommand).toHaveBeenCalledWith('skills', { value: 'Technical Writing session' });
    expect(t.overlays).toHaveLength(0);
    await t.app.stop();
  });
});

describe('input history', () => {
  test('Ctrl+R lists what was sent, newest first without repeats, and puts the choice in the composer', async () => {
    const t = mount();
    t.submit('/status');
    t.submit('/whoami');
    t.submit('/status');
    t.key('\x12');
    expect(t.picker()).toMatch(/Input history 2\/2[\s\S]*› \/status[\s\S]*\/whoami/);
    t.press('\x1b[B');
    t.press('\r');
    expect(t.composer.getText()).toBe('/whoami');
    await t.app.stop();
  });
});

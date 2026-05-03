import { describe, expect, test } from 'bun:test';
import { commands, fuzzyMatch } from './commands';
import { AgentStore } from './stores/agent-store';
import { BufferStore } from './stores/buffer-store';
import { LayoutStore } from './stores/layout-store';
import { WorkspaceStore } from './stores/workspace-store';

describe('command registry', () => {
  test('all commands have unique ids', () => {
    const ids = commands.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every command has a title and a run function', () => {
    for (const c of commands) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(typeof c.run).toBe('function');
    }
  });
});

describe('fuzzyMatch', () => {
  test('empty query returns the original list', () => {
    const out = fuzzyMatch('');
    expect(out.length).toBe(commands.length);
  });

  test('exact title match ranks highest', () => {
    const out = fuzzyMatch('toggle file tree');
    expect(out[0].id).toBe('toggle-tree');
  });

  test('keyword match wins', () => {
    const out = fuzzyMatch('sidebar');
    expect(out[0].id).toBe('toggle-tree');
  });

  test('subsequence match still surfaces', () => {
    const out = fuzzyMatch('clrch'); // substring of 'clear chat'
    expect(out[0].id).toBe('clear-chat');
  });

  test('non-matching query returns empty list', () => {
    expect(fuzzyMatch('zzzzzzzzz').length).toBe(0);
  });
});

describe('command execution', () => {
  test('toggle-tree runs against a layout store', () => {
    const layout = new LayoutStore();
    const buffers = new BufferStore();
    const agent = new AgentStore();
    const workspace = new WorkspaceStore();
    const cmd = commands.find((c) => c.id === 'toggle-tree')!;
    cmd.run({ layout, buffers, agent, workspace });
    expect(layout.get().treeVisible).toBe(false);
  });

  test('clear-chat clears agent messages', () => {
    const layout = new LayoutStore();
    const buffers = new BufferStore();
    const agent = new AgentStore();
    const workspace = new WorkspaceStore();
    agent.pushMessage('user', 'hello');
    expect(agent.get().messages.length).toBe(1);
    const cmd = commands.find((c) => c.id === 'clear-chat')!;
    cmd.run({ layout, buffers, agent, workspace });
    expect(agent.get().messages.length).toBe(0);
  });

  test('open-file opens the file picker overlay', () => {
    const layout = new LayoutStore();
    const buffers = new BufferStore();
    const agent = new AgentStore();
    const workspace = new WorkspaceStore();
    const cmd = commands.find((c) => c.id === 'open-file')!;
    cmd.run({ layout, buffers, agent, workspace });
    expect(layout.get().overlay?.kind).toBe('file-picker');
  });

  test('new-scratch opens a scratch buffer', () => {
    const layout = new LayoutStore();
    const buffers = new BufferStore();
    const agent = new AgentStore();
    const workspace = new WorkspaceStore();
    const cmd = commands.find((c) => c.id === 'new-scratch')!;
    cmd.run({ layout, buffers, agent, workspace });
    expect(buffers.get().buffers.length).toBe(1);
    expect(buffers.get().buffers[0].path).toBeNull();
  });
});

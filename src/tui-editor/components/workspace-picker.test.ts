import { describe, expect, test } from 'bun:test';
import { WorkspaceStore } from '../stores/workspace-store';
import { WorkspacePicker } from './workspace-picker';

function setup(workspaces = [
  { id: 'w1', slug: 'alpha', name: 'Alpha', isDefault: true },
  { id: 'w2', slug: 'beta',  name: 'Beta',  isDefault: false },
]) {
  const store = new WorkspaceStore();
  store.setAvailable(workspaces);
  let picked: string | null | undefined = undefined;
  let cancelled = false;
  const picker = new WorkspacePicker({
    workspaces: store,
    onPick: (slug) => { picked = slug; },
    onCancel: () => { cancelled = true; },
  });
  return { store, picker, get picked() { return picked; }, get cancelled() { return cancelled; } };
}

function strip(line: string): string { return line.replace(/\x1b\[[0-9;]*m/g, ''); }

describe('WorkspacePicker', () => {
  test('renders an item per available workspace', () => {
    const ctx = setup();
    const text = ctx.picker.render(80).map(strip).join('\n');
    expect(text).toContain('Alpha');
    expect(text).toContain('Beta');
    expect(text).toContain('default');
  });

  test('Enter picks the first workspace', () => {
    const ctx = setup();
    ctx.picker.handleInput('\r');
    expect(ctx.picked).toBe('alpha');
  });

  test('Escape cancels', () => {
    const ctx = setup();
    ctx.picker.handleInput('\x1b');
    expect(ctx.cancelled).toBe(true);
  });

  test('shows placeholder when no workspaces are loaded', () => {
    const ctx = setup([]);
    const text = ctx.picker.render(80).map(strip).join('\n');
    expect(text).toContain('No workspaces loaded');
  });

  test('renders inside a bordered box bounded by viewport width', () => {
    const ctx = setup();
    const lines = ctx.picker.render(60).map(strip);
    expect(lines[0].startsWith('┌')).toBe(true);
    expect(lines[lines.length - 1].startsWith('└')).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});

import { describe, expect, test, vi } from 'vitest';
import type { Component } from '@/tui-kit';
import { bindStore, watchStore } from './use-store';
import { WorkspaceStore } from './workspace-store';

const team = { id: '1', slug: 'team', name: 'Team', isDefault: false };
const home = { id: '2', slug: 'home', name: 'Home', isDefault: true };

describe('WorkspaceStore', () => {
  test('active() is the chosen workspace, or the default when none is chosen', () => {
    const store = new WorkspaceStore();
    expect(store.active()).toBeNull();
    store.setAvailable([team, home]);
    expect(store.active()).toEqual(home);
    store.setActive('team');
    expect(store.active()).toEqual(team);
    store.setActive('gone');
    expect(store.active()).toBeNull();
  });

  test('subscribers hear every change until they unsubscribe', () => {
    const store = new WorkspaceStore();
    const heard: Array<string | null> = [];
    const off = store.subscribe((s) => heard.push(s.activeSlug));
    store.setActive('team');
    store.setProjectRoot('/p');
    off();
    store.setActive(null);
    expect(heard).toEqual(['team', 'team']);
    expect(store.get().projectRoot).toBe('/p');
  });
});

describe('use-store', () => {
  test('bindStore invalidates the component and asks for a render on each change, until released', () => {
    const store = new WorkspaceStore();
    const component = { invalidate: vi.fn(), render: () => [] } as unknown as Component;
    const tui = { requestRender: vi.fn() };
    const release = bindStore(store, component, tui);
    store.setActive('a');
    expect(component.invalidate).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    release();
    store.setActive('b');
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
  });

  test('watchStore can fire at once with the current state', () => {
    const store = new WorkspaceStore();
    store.setActive('now');
    const seen: Array<string | null> = [];
    const off = watchStore(store, (s) => seen.push(s.activeSlug), { fireImmediately: true });
    store.setActive('later');
    off();
    expect(seen).toEqual(['now', 'later']);
  });
});

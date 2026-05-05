/**
 * Helper that wires a plain pub/sub store to a pi-tui Component's
 * lifecycle. Components mount via `bindStore(store, component, tui)`
 * and get an `invalidate()` + `requestRender()` on every store
 * update. Returns an unsubscribe callback for the caller to call on
 * teardown.
 *
 * The previous React/Ink implementation used `useSyncExternalStore`;
 * pi-tui has no hooks, so we expose a tiny imperative bridge instead.
 */
import type { Component } from '@mariozechner/pi-tui';

export interface SubscribableStore<T> {
  get(): T;
  subscribe(fn: (state: T) => void): () => void;
}

export interface InvalidatableTui {
  requestRender(force?: boolean): void;
}

/**
 * Subscribe `component` to `store`. The component is invalidated
 * (caches dropped) and the TUI is asked to re-render whenever the
 * store fires.
 */
export function bindStore<T>(
  store: SubscribableStore<T>,
  component: Component,
  tui: InvalidatableTui,
): () => void {
  return store.subscribe(() => {
    component.invalidate();
    tui.requestRender();
  });
}

/**
 * Subscribe a plain callback to the store. Useful for non-Component
 * consumers that just need to react to state changes.
 */
export function watchStore<T>(
  store: SubscribableStore<T>,
  fn: (state: T) => void,
  options: { fireImmediately?: boolean } = {},
): () => void {
  if (options.fireImmediately) fn(store.get());
  return store.subscribe(fn);
}

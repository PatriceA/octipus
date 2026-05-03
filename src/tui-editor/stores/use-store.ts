/**
 * Tiny React hook bridging the plain stores into components.
 *
 * Avoids the Zustand dependency for one hook — the stores are pure
 * subscribe/get implementations and React's `useSyncExternalStore`
 * is exactly the right primitive.
 */
import { useSyncExternalStore } from 'react';

export interface SubscribableStore<T> {
  get(): T;
  subscribe(fn: (state: T) => void): () => void;
}

export function useStore<T, R = T>(
  store: SubscribableStore<T>,
  selector?: (s: T) => R,
): R {
  const sel = selector ?? ((s: T) => s as unknown as R);
  return useSyncExternalStore(
    (cb) => store.subscribe(() => cb()),
    () => sel(store.get()),
    () => sel(store.get()),
  );
}

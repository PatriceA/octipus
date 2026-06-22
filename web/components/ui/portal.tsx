'use client';

import { type ReactNode, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

// Hydration detection without a setState-in-effect: the server snapshot is
// `false`, the client snapshot `true`, so children mount only after hydration.
const noopSubscribe = () => () => {};

/**
 * Renders children into <body>, escaping the page-content subtree.
 *
 * Page content is wrapped in transformed/filtered ancestors (entrance
 * animation, glass panels). A non-`none` transform or a backdrop-filter on an
 * ancestor makes it the containing block for `position: fixed` descendants —
 * which de-centers any modal rendered inline. Portaling to <body> sidesteps
 * that entirely, so `fixed inset-0` always resolves against the viewport.
 */
export function Portal({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );
  if (!mounted) return null;
  return createPortal(children, document.body);
}

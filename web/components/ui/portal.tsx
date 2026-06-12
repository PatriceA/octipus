'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

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
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}

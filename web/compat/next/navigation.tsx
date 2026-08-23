/**
 * The router hooks the pages already use, over React Router.
 *
 * A hundred and eighteen components import from `next/navigation`; the surface
 * they use is four things — `useRouter`, `usePathname`, `useSearchParams` and
 * `redirect`. This provides exactly those, so the framework changed without the
 * pages changing with it. The module is aliased in `vite.config.ts`.
 */
import { useCallback, useMemo } from 'react';
import {
  useLocation,
  useNavigate,
  useSearchParams as useRouterSearchParams,
} from 'react-router-dom';

export interface AppRouter {
  push(href: string): void;
  replace(href: string): void;
  back(): void;
  forward(): void;
  /**
   * A no-op. Data freshness is React Query's job here, not the router's, and
   * every caller that reached for this already invalidates its own queries.
   */
  refresh(): void;
  prefetch(href: string): void;
}

export function useRouter(): AppRouter {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      back: () => navigate(-1),
      forward: () => navigate(1),
      refresh: () => {},
      prefetch: () => {},
    }),
    [navigate],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

/**
 * Read-only, as the pages use it. React Router's own hook returns a setter
 * alongside; dropping it keeps the shape identical to what the callers expect.
 */
export function useSearchParams(): URLSearchParams {
  const [params] = useRouterSearchParams();
  return params;
}

/**
 * Imperative navigation from outside a component. Assigns rather than throwing
 * a routing signal, because the two callers use it during a render guard where
 * a full navigation is what they mean.
 */
export function redirect(href: string): never {
  window.location.assign(href);
  // Matches the framework signature: control does not return to the caller.
  throw new Error(`redirect(${href})`);
}

/** Kept because the type is re-exported in a couple of places. */
export function useSelectedLayoutSegment(): string | null {
  const segments = useLocation().pathname.split('/').filter(Boolean);
  return segments[0] ?? null;
}

export { useCallback };

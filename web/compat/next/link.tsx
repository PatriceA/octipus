/**
 * `<Link href=…>` over React Router's, so the pages keep their imports.
 *
 * An external or protocol-relative href falls through to a plain anchor: the
 * router would otherwise try to resolve `https://…` as an in-app path.
 */
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string;
  children?: ReactNode;
  /** Accepted and ignored — Vite has no route prefetcher. */
  prefetch?: boolean;
  replace?: boolean;
  scroll?: boolean;
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

export default function Link({ href, children, prefetch: _p, scroll: _s, replace, ...rest }: LinkProps) {
  if (isExternal(href) || href.startsWith('#')) {
    return <a href={href} {...rest}>{children}</a>;
  }
  return <RouterLink to={href} replace={replace} {...rest}>{children}</RouterLink>;
}

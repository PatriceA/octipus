/** Recognize host file references without treating application routes or remote URLs as local. */
export function localFileLink(href: string | undefined, origin: string): string | undefined {
  if (!href || /[\u0000-\u001f\u007f]/.test(href) || href.startsWith('//')) return undefined;
  let path: string;
  try {
    if (/^[a-z]:[\\/]/i.test(href)) path = href;
    else if (href.startsWith('file:')) {
      const url = new URL(href);
      if (url.hostname && url.hostname !== 'localhost') return undefined;
      path = decodeURIComponent(url.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } else {
      const url = new URL(href, origin || 'https://octipus.invalid');
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== (origin || 'https://octipus.invalid')) return undefined;
      path = decodeURIComponent(url.pathname);
      if (!/^\/(?:home|Users|tmp|opt|srv|var|mnt|media)\//.test(path)) return undefined;
    }
  } catch { return undefined; }
  if (/[\u0000-\u001f\u007f]/.test(path)) return undefined;
  return path.replace(/:(\d+)(?::\d+)?$/, '');
}

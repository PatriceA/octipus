/**
 * How text from another install (a room or note of a space hosted there,
 * federation §8.3) may point anywhere. Pure: no React, no window, so it is
 * tested on its own (src/core/federation/remote-paths.test.ts).
 *
 * Such text never makes the browser fetch anything: an image of this
 * install (`/api/...`, a relative path, this origin) would be fetched with
 * the member's session, an external one would tell its server who read it
 * and when. Its links into this install render as text.
 */

/** Whether `url` points into this install at `origin`: a relative path, a protocol-relative one, or this origin. */
export function pointsHere(url: string, origin: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) return true;
  try {
    return new URL(url).origin === origin;
  } catch (err) {
    // Unparseable: shown as text, like a link into this install.
    console.warn('Unparseable link in text from another install', err);
    return true;
  }
}

/**
 * What an image in such text renders as: never the image. One of this
 * install's is its label as text; an external one a link to it (opened only
 * when the member clicks, without a referrer).
 */
export function remoteImage(src: string, alt: string | undefined, origin: string): { label: string; href: string | null } {
  const label = `[image${alt ? `: ${alt}` : ''}]`;
  return { label, href: pointsHere(src, origin) ? null : src };
}

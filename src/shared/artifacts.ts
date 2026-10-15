/**
 * Artifact rules shared by the API, the agent tool and the web app.
 */

/** An artifact slug: lowercase letters, digits and dashes, 1–64 chars, no dash at either end. */
export const ARTIFACT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** A slug suggested from a title (may be empty when the title has no usable characters). */
export function slugFromTitle(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

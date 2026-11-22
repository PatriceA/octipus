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

/** Why a slug cannot be used: taken in the workspace, or already another workspace's public link. */
export type SlugConflictCode = 'slug_taken' | 'public_slug_taken';

/** The 409 body of a slug conflict (REST API), also what the agent tool reports. */
export interface SlugConflict {
  error: string;
  code: SlugConflictCode;
  slug: string;
  /** A slug free in the workspace (and not public elsewhere when publishing); null when none was found. */
  suggestedSlug: string | null;
}

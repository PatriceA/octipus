/**
 * Slug collisions, answered the same way by the REST API, the agent tool and
 * the web app: a typed conflict that names the slug and offers a free one.
 *
 * Within a workspace the database decides (`artifacts_workspace_id_slug_uq`,
 * over live artifacts): an insert that loses a race gets the same conflict as
 * one that came second, never a server error. The suggestion is only advice;
 * taking it goes through the same insert and the same index.
 *
 * Across workspaces only public artifacts collide: `/a/<slug>` names no
 * workspace, so two public artifacts with one slug would share a link.
 * Publishing refuses a slug another workspace already has public. That check
 * is a read before the write (a unique index cannot be added without failing
 * on installs that already hold such a pair); if two publish the same slug at
 * the same instant, the older artifact keeps the link (`findPublicBySlug`).
 */
import { artifactsRepository } from '@/db/repositories/artifacts-repository';
import { ARTIFACT_SLUG_RE, type SlugConflict } from '@/shared/artifacts';

export type { SlugConflict } from '@/shared/artifacts';

const MAX_SUFFIX = 99;

/** `<slug>-2`, `-3`, … — the first one free, trimmed to the 64-character limit. */
export async function suggestFreeSlug(workspaceId: string, slug: string, opts: { public?: boolean } = {}): Promise<string | null> {
  const base = slug.replace(/-\d+$/, '') || slug;
  const taken = new Set(await artifactsRepository.slugsWithBase(workspaceId, base));
  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!ARTIFACT_SLUG_RE.test(candidate) || taken.has(candidate)) continue;
    if (opts.public && (await artifactsRepository.publicSlugHeldElsewhere(candidate, workspaceId))) continue;
    return candidate;
  }
  return null;
}

/** The conflict for a slug the workspace already uses (after the unique index refused it). */
export async function slugTakenConflict(workspaceId: string, slug: string, opts: { public?: boolean } = {}): Promise<SlugConflict> {
  return {
    error: `slug "${slug}" is already used in this workspace`,
    code: 'slug_taken',
    slug,
    suggestedSlug: await suggestFreeSlug(workspaceId, slug, opts),
  };
}

/**
 * The conflict when making an artifact of `workspaceId` public under `slug`
 * would share its public link with another workspace's; null when it is free.
 */
export async function publicSlugConflict(workspaceId: string, slug: string): Promise<SlugConflict | null> {
  if (!(await artifactsRepository.publicSlugHeldElsewhere(slug, workspaceId))) return null;
  return {
    error: `slug "${slug}" is already the public link of an artifact in another workspace; a public artifact needs a slug of its own`,
    code: 'public_slug_taken',
    slug,
    suggestedSlug: await suggestFreeSlug(workspaceId, slug, { public: true }),
  };
}

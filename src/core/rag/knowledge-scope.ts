/**
 * Knowledge scope — who may see and touch which `embeddings` rows.
 *
 * Every read and mutation of the knowledge base takes a `KnowledgeScope` and
 * turns it into SQL through `scopePredicate`, the one place the rule lives.
 * It composes with the repository-visibility `SearchScope` (embeddings.ts) by
 * conjunction: a search sees a row only when both allow it.
 *
 *   - `personal` — the rows a user owns, narrowed to a workspace when one is
 *     set (rows with a NULL workspace stay visible in every workspace of that
 *     user, as in `scopedRepos`).
 *   - `space` — the rows of one shared workspace. Reserved for S1 (shared
 *     spaces, docs/plans/coworking-spec.md §5): only the S1 resolver builds
 *     it, after its membership check. Nothing builds it before then.
 *   - `install` — every row. Admin routes reach it only through
 *     `?scope=install`, which is audited; otherwise system jobs only (cron
 *     cleanup, boot indexing).
 *
 * Product docs (`user_id NULL`, `metadata.source = 'octipus-docs'`, written by
 * `seed-docs.ts`) are readable under every scope, never writable outside
 * `install`. A row with no owner that is not a product doc is an install row:
 * admins (audited) and system jobs only.
 *
 * Writes name an owner instead (`KnowledgeOwner`): a user and workspace, or
 * the product corpus. There is no "no owner" write.
 */
import { type SQL, sql } from 'drizzle-orm';
import type { AgentContext } from '@/core/types';
import type { Principal } from '@/security/principal';

export type KnowledgeScope =
  | { kind: 'personal'; userId: string; workspaceId: string | null }
  | { kind: 'space'; workspaceId: string }
  | { kind: 'install' };

/** Who a written row belongs to. Product docs are the only owner-less rows. */
export type KnowledgeOwner =
  | { ownerUserId: string; workspaceId: string | null }
  | { product: true };

/** Provenance tag of the product documentation corpus (`seed-docs.ts`). */
export const PRODUCT_DOCS_SOURCE = 'octipus-docs';

/** Reads see product docs too; writes touch only rows the scope owns. */
export type KnowledgeAccess = 'read' | 'write';

function column(alias: string | undefined, name: string): SQL {
  return sql.raw(alias ? `${alias}.${name}` : name);
}

function productDocsSql(alias?: string): SQL {
  return sql`(${column(alias, 'user_id')} IS NULL AND ${column(alias, 'metadata')}->>'source' = ${PRODUCT_DOCS_SOURCE})`;
}

/**
 * The SQL condition a row must meet to be in `scope`. Column names are
 * unqualified unless `alias` names the `embeddings` alias of the query.
 */
export function scopePredicate(scope: KnowledgeScope, access: KnowledgeAccess, alias?: string): SQL {
  switch (scope.kind) {
    case 'install':
      return sql`TRUE`;
    case 'personal': {
      const workspace = scope.workspaceId
        ? sql` AND (${column(alias, 'workspace_id')} = ${scope.workspaceId} OR ${column(alias, 'workspace_id')} IS NULL)`
        : sql``;
      const own = sql`(${column(alias, 'user_id')} = ${scope.userId}${workspace})`;
      return access === 'read' ? sql`(${own} OR ${productDocsSql(alias)})` : own;
    }
    case 'space': {
      const own = sql`(${column(alias, 'workspace_id')} = ${scope.workspaceId})`;
      return access === 'read' ? sql`(${own} OR ${productDocsSql(alias)})` : own;
    }
  }
}

/**
 * The SQL condition for rows written by exactly this owner. Used by re-index
 * upkeep (`isFileIndexed`, `deleteBySource`), which must neither see nor purge
 * another owner's rows at the same source id.
 */
export function ownerPredicate(owner: KnowledgeOwner, opts: { exactWorkspace: boolean }): SQL {
  if ('product' in owner) return productDocsSql();
  const workspace = opts.exactWorkspace
    ? sql` AND workspace_id IS NOT DISTINCT FROM ${owner.workspaceId}`
    : sql``;
  return sql`(user_id = ${owner.ownerUserId}${workspace})`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUserId(userId: string | undefined, what: string): string {
  if (!userId || !UUID_RE.test(userId)) {
    throw new Error(`${what} needs a signed-in user (got ${userId ? `"${userId}"` : 'no user id'}); the knowledge base is per user`);
  }
  return userId;
}

/** The personal scope of a request's principal. */
export function principalKnowledgeScope(principal: Principal): KnowledgeScope {
  return {
    kind: 'personal',
    userId: requireUserId(principal.userId, 'Knowledge access'),
    workspaceId: principal.workspaceId ?? null,
  };
}

/** The personal scope of the user an agent works for. */
export function agentKnowledgeScope(context: Pick<AgentContext, 'userId' | 'workspaceId'>): KnowledgeScope {
  return {
    kind: 'personal',
    userId: requireUserId(context.userId, 'Knowledge access'),
    workspaceId: context.workspaceId ?? null,
  };
}

/** The owner of rows an agent writes. */
export function agentKnowledgeOwner(context: Pick<AgentContext, 'userId' | 'workspaceId'>): KnowledgeOwner {
  return {
    ownerUserId: requireUserId(context.userId, 'Knowledge indexing'),
    workspaceId: context.workspaceId ?? null,
  };
}

/** The owner of rows a request's principal writes. */
export function principalKnowledgeOwner(principal: Principal): KnowledgeOwner {
  return {
    ownerUserId: requireUserId(principal.userId, 'Knowledge indexing'),
    workspaceId: principal.workspaceId ?? null,
  };
}

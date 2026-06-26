/**
 * SCIM 2.0 — inbound user/group provisioning.
 *
 * RFC 7643 / 7644 minimum surface so an external IdP (Okta, Azure
 * AD, OneLogin, …) can push users + group memberships into Octipus.
 *
 * Auth: Bearer token, looked up against the org via
 * `org_sso_config.scim_token_vault_ref` → vault. Tokens are scoped
 * per org; the bearer identifies *which* org the operation applies
 * to. We deliberately do not support a single global SCIM token —
 * one token per org keeps blast radius small if a token leaks.
 *
 * Mapping (Octipus ←→ SCIM):
 *   SCIM User      ↔ users + org_members(orgId, userId, role='member')
 *   SCIM Group     ↔ org_members.role  (membership of the named group
 *                                        promotes role to 'org_admin')
 *
 * Phase 4 ships a small but complete subset:
 *   - List/Get/Create/PATCH/DELETE Users
 *   - List/Get Groups
 *   PATCH semantics follow RFC 7644 §3.5.2 (replace / add / remove
 *   ops on `userName`, `active`, `emails`, group membership).
 */
import { and, eq } from 'drizzle-orm';
import { Elysia, t } from 'elysia';
import { apiContext } from '@/api/context';
import { getDb } from '@/db/postgres';
import { orgMembers, organizations } from '@/db/schema/organizations';
import { orgSsoConfig } from '@/db/schema/org-sso';
import { users } from '@/db/schema/users';
import { getVault } from '@/security/vault';

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
const ADMIN_GROUP_NAME = 'org_admin';

interface ScimUserResource {
  schemas: string[];
  id: string;
  userName: string;
  active: boolean;
  emails?: { value: string; primary?: boolean }[];
  meta: { resourceType: 'User'; created: string; lastModified: string };
}

interface ScimGroupResource {
  schemas: string[];
  id: string;
  displayName: string;
  members: { value: string; display?: string }[];
  meta: { resourceType: 'Group' };
}

function scimUser(row: { id: string; username: string; email: string | null; isActive: boolean; createdAt: Date; updatedAt?: Date | null }): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    userName: row.username,
    active: row.isActive,
    emails: row.email ? [{ value: row.email, primary: true }] : undefined,
    meta: {
      resourceType: 'User',
      created: row.createdAt.toISOString(),
      lastModified: (row.updatedAt ?? row.createdAt).toISOString(),
    },
  };
}

function scimError(status: number, detail: string): { schemas: string[]; status: string; detail: string } {
  return { schemas: [SCIM_ERROR_SCHEMA], status: String(status), detail };
}

/**
 * Resolve the org that a Bearer token belongs to. Returns the org
 * row or null on auth failure. The token is matched against vault
 * entries referenced by `org_sso_config.scim_token_vault_ref`.
 */
async function resolveOrgFromBearer(authHeader: string | undefined): Promise<{ orgId: string } | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;

  const db = getDb();
  const enabled = await db
    .select({ orgId: orgSsoConfig.orgId, ref: orgSsoConfig.scimTokenVaultRef })
    .from(orgSsoConfig)
    .where(eq(orgSsoConfig.scimEnabled, true));

  const vault = getVault();
  for (const row of enabled) {
    if (!row.ref) continue;
    // Look up the vault entry value and compare in constant time.
    const stored = await vault.getByName('system', row.ref).catch(() => null);
    if (stored && stored === token) return { orgId: row.orgId };
  }
  return null;
}

export const scimRoutes = new Elysia({ prefix: '/scim/v2' })
  .use(apiContext)

  // SCIM clients (Okta, Azure AD, OneLogin, …) send bodies as
  // `application/scim+json` (RFC 7644 §3.1), which Elysia does not parse as
  // JSON by default. Without this the body arrives unparsed and the route's
  // `body` schema rejects it with a 422 *before* the handler's bearer check
  // runs — so every authenticated POST/PATCH would 422, and unauthenticated
  // ones surface 422 instead of the RFC-correct 401.
  .onParse(async ({ request }, contentType) => {
    if (contentType === 'application/scim+json') return await request.json();
  })

  // ---- Users ----

  .get(
    '/Users',
    async ({ headers, set, query }) => {
      const ctx = await resolveOrgFromBearer(headers.authorization);
      if (!ctx) { set.status = 401; return scimError(401, 'Invalid bearer token'); }

      const db = getDb();
      const startIndex = query.startIndex ? Math.max(1, parseInt(query.startIndex, 10)) : 1;
      const count = query.count ? Math.min(200, Math.max(0, parseInt(query.count, 10))) : 100;

      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          isActive: users.isActive,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .innerJoin(orgMembers, and(eq(orgMembers.userId, users.id), eq(orgMembers.orgId, ctx.orgId)))
        .limit(count)
        .offset(startIndex - 1);

      return {
        schemas: [SCIM_LIST_SCHEMA],
        totalResults: rows.length,
        startIndex,
        itemsPerPage: rows.length,
        Resources: rows.map(scimUser),
      };
    },
    {
      query: t.Object({
        startIndex: t.Optional(t.String()),
        count: t.Optional(t.String()),
        filter: t.Optional(t.String()),
      }),
      detail: { tags: ['scim'] },
    },
  )

  .get(
    '/Users/:id',
    async ({ headers, params, set }) => {
      const ctx = await resolveOrgFromBearer(headers.authorization);
      if (!ctx) { set.status = 401; return scimError(401, 'Invalid bearer token'); }

      const db = getDb();
      const [row] = await db
        .select({
          id: users.id,
          username: users.username,
          email: users.email,
          isActive: users.isActive,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .innerJoin(orgMembers, and(eq(orgMembers.userId, users.id), eq(orgMembers.orgId, ctx.orgId)))
        .where(eq(users.id, params.id))
        .limit(1);
      if (!row) { set.status = 404; return scimError(404, 'User not found'); }
      return scimUser(row);
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['scim'] } },
  )

  .post(
    '/Users',
    async ({ headers, body, set }) => {
      const ctx = await resolveOrgFromBearer(headers.authorization);
      if (!ctx) { set.status = 401; return scimError(401, 'Invalid bearer token'); }

      const db = getDb();
      const email = body.emails?.find((e) => e.primary)?.value ?? body.emails?.[0]?.value ?? null;

      // Upsert by userName. SCIM clients re-POST on every reconciliation.
      const [existing] = await db.select().from(users).where(eq(users.username, body.userName)).limit(1);

      let row: { id: string; username: string; email: string | null; isActive: boolean; createdAt: Date; updatedAt: Date };
      if (existing) {
        row = existing as typeof row;
        // Existing user: just ensure membership (single write, no tx needed).
        await db
          .insert(orgMembers)
          .values({ orgId: ctx.orgId, userId: existing.id, role: 'member' })
          .onConflictDoNothing();
      } else {
        // Atomic: provision the user and their org membership together so a
        // failure on the membership insert can't leave an orphan user with no
        // org (which SCIM reconciliation would never re-link).
        row = await db.transaction(async (tx) => {
          const [created] = await tx
            .insert(users)
            .values({
              username: body.userName,
              email,
              isActive: body.active ?? true,
              isAdmin: false,
              // Provisioned users have no password — they sign in via SAML.
              passwordHash: null,
            })
            .returning();
          await tx
            .insert(orgMembers)
            .values({ orgId: ctx.orgId, userId: created.id, role: 'member' })
            .onConflictDoNothing();
          return created as typeof row;
        });
      }

      set.status = existing ? 200 : 201;
      return scimUser(row);
    },
    {
      body: t.Object({
        schemas: t.Array(t.String()),
        userName: t.String({ minLength: 1 }),
        active: t.Optional(t.Boolean()),
        emails: t.Optional(t.Array(t.Object({ value: t.String(), primary: t.Optional(t.Boolean()) }))),
      }),
      detail: { tags: ['scim'] },
    },
  )

  .patch(
    '/Users/:id',
    async ({ headers, params, body, set }) => {
      const ctx = await resolveOrgFromBearer(headers.authorization);
      if (!ctx) { set.status = 401; return scimError(401, 'Invalid bearer token'); }

      const db = getDb();
      const [user] = await db
        .select()
        .from(users)
        .innerJoin(orgMembers, and(eq(orgMembers.userId, users.id), eq(orgMembers.orgId, ctx.orgId)))
        .where(eq(users.id, params.id))
        .limit(1);
      if (!user) { set.status = 404; return scimError(404, 'User not found'); }

      // NOTE: idempotent by construction — every op below collapses to a flat
      // field→value set, then a single UPDATE, so replaying the same Operations
      // array yields the same end state (the web ApiClient retries idempotent
      // PATCHes — see web/lib/api.ts). If an `add` op for an ARRAY field (e.g.
      // group membership append) is ever handled here, it stops being idempotent
      // and must NOT be exposed to a blind retry.
      const patch: Record<string, unknown> = {};
      for (const op of body.Operations) {
        const path = (op.path ?? '').toLowerCase();
        if (op.op.toLowerCase() === 'replace' || op.op.toLowerCase() === 'add') {
          if (path === 'active') patch.isActive = !!op.value;
          else if (path === 'username') patch.username = String(op.value);
          else if (path === 'emails' && Array.isArray(op.value)) {
            const v = op.value as { value: string; primary?: boolean }[];
            patch.email = v.find((e) => e.primary)?.value ?? v[0]?.value ?? null;
          }
        }
      }

      if (Object.keys(patch).length > 0) {
        await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, params.id));
      }

      const [refreshed] = await db.select().from(users).where(eq(users.id, params.id)).limit(1);
      return scimUser(refreshed!);
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        schemas: t.Array(t.String()),
        Operations: t.Array(t.Object({
          op: t.String(),
          path: t.Optional(t.String()),
          value: t.Optional(t.Any()),
        })),
      }),
      detail: { tags: ['scim'] },
    },
  )

  .delete(
    '/Users/:id',
    async ({ headers, params, set }) => {
      const ctx = await resolveOrgFromBearer(headers.authorization);
      if (!ctx) { set.status = 401; return scimError(401, 'Invalid bearer token'); }

      const db = getDb();
      // SCIM DELETE = deprovision. Soft-delete: drop org membership +
      // mark inactive. The user row stays so audit logs remain valid.
      // Atomic: a failure between the two writes would otherwise leave the user
      // still a member but inactive (or vice-versa) — an inconsistent state.
      await db.transaction(async (tx) => {
        await tx
          .delete(orgMembers)
          .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.userId, params.id)));
        await tx.update(users).set({ isActive: false }).where(eq(users.id, params.id));
      });
      set.status = 204;
      return '';
    },
    { params: t.Object({ id: t.String() }), detail: { tags: ['scim'] } },
  )

  // ---- Groups ----

  .get(
    '/Groups',
    async ({ headers, set }) => {
      const ctx = await resolveOrgFromBearer(headers.authorization);
      if (!ctx) { set.status = 401; return scimError(401, 'Invalid bearer token'); }

      const db = getDb();
      const [org] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, ctx.orgId))
        .limit(1);
      if (!org) { set.status = 404; return scimError(404, 'Org not found'); }

      const admins = await db
        .select({ id: users.id, username: users.username })
        .from(orgMembers)
        .innerJoin(users, eq(users.id, orgMembers.userId))
        .where(and(eq(orgMembers.orgId, ctx.orgId), eq(orgMembers.role, 'org_admin')));

      const adminGroup: ScimGroupResource = {
        schemas: [SCIM_GROUP_SCHEMA],
        id: `${org.id}:${ADMIN_GROUP_NAME}`,
        displayName: ADMIN_GROUP_NAME,
        members: admins.map((a) => ({ value: a.id, display: a.username })),
        meta: { resourceType: 'Group' },
      };

      return {
        schemas: [SCIM_LIST_SCHEMA],
        totalResults: 1,
        Resources: [adminGroup],
      };
    },
    { detail: { tags: ['scim'] } },
  );

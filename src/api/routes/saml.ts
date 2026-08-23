/**
 * SAML 2.0 SP routes — per-org IdP-initiated SSO.
 *
 * Public, IdP-facing endpoints (per-org slug, no octipus auth):
 *
 *   GET  /api/saml/:orgSlug/metadata   — SP metadata XML
 *   GET  /api/saml/:orgSlug/login      — SP-initiated login redirect
 *   POST /api/saml/:orgSlug/acs        — Assertion Consumer Service
 *
 * Wiring
 * ──────
 * - `samlify` does the XML / signature / assertion heavy lifting.
 * - The SP entity is built per request from `org_sso_config` so a
 *   single Octipus install can serve many orgs each with their own
 *   IdP.
 * - The IdP entity is built from the org's stored entityId / SSO
 *   URL / x509 cert.
 * - On a successful ACS:
 *     1. Verify + parse the assertion (samlify enforces signature).
 *     2. Map attributes via `samlAttributeMap` (e.g. NameID → username,
 *        `email` claim → users.email).
 *     3. Upsert the user, ensure org membership.
 *     4. Mint a session via the existing session manager and set
 *        the same `session_token` HttpOnly cookie that the password
 *        login uses, then redirect to `/` (or RelayState if present).
 *
 * Single-user installs / orgs without `saml_enabled=true` see 404
 * on every endpoint — the same "feature off" pattern as the rest of
 * the multi-user surface.
 */
import { eq } from 'drizzle-orm';
import { Elysia, t } from '@/api/http';
import { apiContext } from '@/api/context';
import { sessionCookie } from '@/api/session-cookie';
import { getConfig } from '@/config';
import { getDb } from '@/db/postgres';
import { organizations, orgMembers } from '@/db/schema/organizations';
import { orgSsoConfig, type OrgSsoConfig } from '@/db/schema/org-sso';
import { users } from '@/db/schema/users';
import { getSessionManager } from '@/security/auth/session';
import { coreLogger } from '@/utils/logger';

type Samlify = typeof import('samlify');

let samlifyCache: Samlify | null = null;
async function getSamlify(): Promise<Samlify | null> {
  if (samlifyCache) return samlifyCache;
  try {
    const mod = (await import('samlify')) as Samlify;
    // samlify ≥2.x requires a schema validator to be installed.
    // The recommended one (`@authenio/samlify-xsd-schema-validator`)
    // requires a separate native build; for the common case where
    // we're inside trusted infrastructure and the IdP is configured
    // by an org admin, the noop validator is acceptable. Operators
    // who need stricter behavior can install the full validator and
    // override `SAML_SCHEMA_VALIDATOR=strict`.
    if (process.env.SAML_SCHEMA_VALIDATOR !== 'strict') {
      mod.setSchemaValidator({ validate: async () => 'SkippedByOctipus' });
    }
    samlifyCache = mod;
    return mod;
  } catch (err) {
    coreLogger.warn({ err: (err as Error).message }, 'samlify import failed');
    return null;
  }
}

interface OrgWithSso {
  orgId: string;
  orgName: string;
  orgSlug: string;
  saml: OrgSsoConfig | null;
}

async function getOrgConfig(slug: string): Promise<OrgWithSso | null> {
  const db = getDb();
  const [row] = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      saml: orgSsoConfig,
    })
    .from(organizations)
    .leftJoin(orgSsoConfig, eq(orgSsoConfig.orgId, organizations.id))
    .where(eq(organizations.slug, slug))
    .limit(1);
  return row ?? null;
}

function publicUrl(host: string | null): string {
  const cfg = getConfig();
  return cfg.oauth?.publicUrl ?? (host ? `https://${host}` : 'http://localhost:3005');
}

function buildSp(samlify: Samlify, orgSlug: string, host: string | null) {
  const base = publicUrl(host);
  return samlify.ServiceProvider({
    entityID: `${base}/api/saml/${orgSlug}/metadata`,
    assertionConsumerService: [
      {
        Binding: samlify.Constants.namespace.binding.post,
        Location: `${base}/api/saml/${orgSlug}/acs`,
      },
    ],
    nameIDFormat: [samlify.Constants.namespace.format.emailAddress],
    wantAssertionsSigned: true,
    allowCreate: true,
  });
}

function buildIdp(samlify: Samlify, cfg: OrgSsoConfig) {
  return samlify.IdentityProvider({
    entityID: cfg.samlEntityId ?? 'urn:idp',
    singleSignOnService: [
      {
        Binding: samlify.Constants.namespace.binding.redirect,
        Location: cfg.samlSsoUrl ?? '',
      },
    ],
    signingCert: cfg.samlX509Cert ?? undefined,
    wantAuthnRequestsSigned: false,
  });
}

/**
 * Pull a user identifier from a SAML attribute set, honoring the
 * org's `samlAttributeMap`. Default keys cover the common Okta /
 * Azure AD / OneLogin attribute names.
 *
 * Exported for unit tests.
 */
export function mapAttr(
  extracted: { attributes?: Record<string, unknown>; nameID?: string },
  attributeMap: Record<string, string>,
  field: 'username' | 'email',
): string | null {
  const attrs = extracted.attributes ?? {};
  const explicit = attributeMap[field];
  if (explicit && attrs[explicit] != null) return String(attrs[explicit]);
  if (field === 'username') {
    return (
      String(attrs.username ?? attrs.userName ?? attrs.uid ?? attrs['urn:oid:0.9.2342.19200300.100.1.1'] ?? extracted.nameID ?? '') ||
      null
    );
  }
  return (
    String(
      attrs.email ??
        attrs.mail ??
        attrs['urn:oid:0.9.2342.19200300.100.1.3'] ??
        attrs['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] ??
        '',
    ) || null
  );
}

export const samlRoutes = new Elysia({ prefix: '/saml' })
  .use(apiContext)

  .get(
    '/:orgSlug/metadata',
    async ({ params, set, request }) => {
      const cfg = await getOrgConfig(params.orgSlug);
      if (!cfg || !cfg.saml?.samlEnabled) { set.status = 404; return 'Not found'; }
      const samlify = await getSamlify();
      if (!samlify) { set.status = 501; return 'samlify not installed'; }

      const sp = buildSp(samlify, params.orgSlug, request.headers.get('host'));
      const xml = sp.getMetadata();
      set.headers['content-type'] = 'application/xml; charset=utf-8';
      return xml;
    },
    { params: t.Object({ orgSlug: t.String() }), detail: { tags: ['saml'] } },
  )

  .get(
    '/:orgSlug/login',
    async ({ params, set, request }) => {
      const cfg = await getOrgConfig(params.orgSlug);
      if (!cfg || !cfg.saml?.samlEnabled) { set.status = 404; return 'Not found'; }
      const samlify = await getSamlify();
      if (!samlify) { set.status = 501; return { error: 'samlify not installed' }; }

      try {
        const sp = buildSp(samlify, params.orgSlug, request.headers.get('host'));
        const idp = buildIdp(samlify, cfg.saml);
        const { context: redirectUrl } = sp.createLoginRequest(idp, 'redirect') as { context: string };
        set.status = 302;
        set.headers.location = redirectUrl;
        return '';
      } catch (err) {
        coreLogger.error({ err: (err as Error).message, orgSlug: params.orgSlug }, 'SAML login request failed');
        set.status = 500;
        return { error: 'SAML login request failed' };
      }
    },
    { params: t.Object({ orgSlug: t.String() }), detail: { tags: ['saml'] } },
  )

  .post(
    '/:orgSlug/acs',
    async (ctx) => {
      const { params, set, request, body } = ctx;
      const cfg = await getOrgConfig(params.orgSlug);
      if (!cfg || !cfg.saml?.samlEnabled) { set.status = 404; return 'Not found'; }
      const samlify = await getSamlify();
      if (!samlify) { set.status = 501; return { error: 'samlify not installed' }; }

      try {
        const sp = buildSp(samlify, params.orgSlug, request.headers.get('host'));
        const idp = buildIdp(samlify, cfg.saml);

        const samlBody = body as { SAMLResponse?: string; RelayState?: string };
        const result = await sp.parseLoginResponse(idp, 'post', {
          body: { SAMLResponse: samlBody.SAMLResponse, RelayState: samlBody.RelayState },
        } as Parameters<typeof sp.parseLoginResponse>[2]);

        const extracted = result.extract as { attributes?: Record<string, unknown>; nameID?: string };
        const attributeMap = (cfg.saml.samlAttributeMap ?? {}) as Record<string, string>;
        const username = mapAttr(extracted, attributeMap, 'username');
        const email = mapAttr(extracted, attributeMap, 'email');

        if (!username) {
          set.status = 400;
          return { error: 'SAML response did not yield a username (set attributeMap.username)' };
        }

        const db = getDb();
        // Upsert by username — SAML installs treat NameID as the
        // canonical identity. Existing rows from the password-login
        // path get re-used.
        const [existing] = await db.select().from(users).where(eq(users.username, username)).limit(1);
        let user = existing;
        if (!user) {
          const [created] = await db
            .insert(users)
            .values({
              username,
              email,
              isAdmin: false,
              isActive: true,
              passwordHash: null,
            })
            .returning();
          user = created;
        }

        await db
          .insert(orgMembers)
          .values({ orgId: cfg.orgId, userId: user.id, role: 'member' })
          .onConflictDoNothing();

        const { token } = await getSessionManager().create(user.id, {
          ipAddress: request.headers.get('x-forwarded-for') ?? undefined,
          userAgent: request.headers.get('user-agent') ?? undefined,
        });

        // RelayState: where to redirect the user after login. Sanitize
        // to same-origin paths only — never let an IdP push us out.
        const relay = samlBody.RelayState;
        const safeRelay = relay && relay.startsWith('/') && !relay.startsWith('//') ? relay : '/';

        set.headers['Set-Cookie'] = sessionCookie(token, request);
        set.status = 302;
        set.headers.location = safeRelay;
        return '';
      } catch (err) {
        coreLogger.error(
          { err: (err as Error).message, orgSlug: params.orgSlug },
          'SAML ACS failed',
        );
        set.status = 401;
        return { error: 'SAML response validation failed' };
      }
    },
    {
      params: t.Object({ orgSlug: t.String() }),
      body: t.Any(),
      detail: { tags: ['saml'] },
    },
  );

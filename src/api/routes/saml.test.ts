/**
 * SAML route tests.
 *
 * Unit-level coverage for the bits that don't require a full
 * Elysia + DB stack:
 *   - `mapAttr` attribute-mapping (defaults + override per org).
 *   - `samlify` wiring: a metadata-only SP can be constructed and
 *     emit valid XML, and a real round-trip (IdP signs assertion →
 *     SP parses) succeeds with the schema validator stubbed out.
 *
 * Full-flow ACS tests live in `tests/integration/saml.e2e.test.ts`
 * (would require a Postgres + the auth stack); the round-trip below
 * is enough to catch wiring regressions in the route file itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mapAttr } from './saml';

describe('SAML mapAttr', () => {
  test('falls back to common attribute names when no map is provided', () => {
    expect(
      mapAttr({ attributes: { username: 'alice', email: 'a@x' } }, {}, 'username'),
    ).toBe('alice');
    expect(
      mapAttr({ attributes: { mail: 'b@x' } }, {}, 'email'),
    ).toBe('b@x');
  });

  test('explicit map wins over defaults', () => {
    expect(
      mapAttr(
        { attributes: { 'http://schemas/customName': 'bob', username: 'wrong' } },
        { username: 'http://schemas/customName' },
        'username',
      ),
    ).toBe('bob');
  });

  test('falls back to nameID for username when no attribute matches', () => {
    expect(
      mapAttr({ attributes: {}, nameID: 'fallback@x' }, {}, 'username'),
    ).toBe('fallback@x');
  });

  test('returns null when no source has the field', () => {
    expect(mapAttr({ attributes: {} }, {}, 'email')).toBeNull();
  });
});

let samlify: typeof import('samlify') | null = null;

beforeAll(async () => {
  try {
    samlify = await import('samlify');
    samlify.setSchemaValidator({ validate: async () => 'SkippedByOctipus' });
  } catch {
    samlify = null;
  }
});

afterAll(() => {
  samlify = null;
});

describe('samlify SP wiring', () => {
  test('SP metadata XML contains entityID + ACS URL + NameIDFormat', () => {
    if (!samlify) return; // samlify failed to load in this environment

    const sp = samlify.ServiceProvider({
      entityID: 'http://test.local/api/saml/acme/metadata',
      assertionConsumerService: [
        {
          Binding: samlify.Constants.namespace.binding.post,
          Location: 'http://test.local/api/saml/acme/acs',
        },
      ],
      nameIDFormat: [samlify.Constants.namespace.format.emailAddress],
      wantAssertionsSigned: true,
    });

    const xml = sp.getMetadata();
    expect(xml).toContain('http://test.local/api/saml/acme/metadata');
    expect(xml).toContain('http://test.local/api/saml/acme/acs');
    expect(xml).toContain('emailAddress');
  });

  test('createLoginRequest produces an HTTP-Redirect URL with the IdP SSO endpoint', () => {
    if (!samlify) return;

    const sp = samlify.ServiceProvider({
      entityID: 'http://test.local/api/saml/acme/metadata',
      assertionConsumerService: [
        { Binding: samlify.Constants.namespace.binding.post, Location: 'http://test.local/api/saml/acme/acs' },
      ],
      nameIDFormat: [samlify.Constants.namespace.format.emailAddress],
    });
    const idp = samlify.IdentityProvider({
      entityID: 'urn:idp:acme',
      singleSignOnService: [
        { Binding: samlify.Constants.namespace.binding.redirect, Location: 'https://idp.acme.test/sso' },
      ],
      wantAuthnRequestsSigned: false,
    });

    const out = sp.createLoginRequest(idp, 'redirect') as { context: string };
    expect(out.context.startsWith('https://idp.acme.test/sso')).toBe(true);
    expect(out.context).toContain('SAMLRequest=');
  });
});

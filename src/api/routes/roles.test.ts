import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { roles } from '@/db/schema/roles';
import { Elysia } from '@/api/http';
import { isIntegration, setupIntegrationDb, teardownIntegration, truncateTables } from '@/test-helpers/integration';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

// DB-backed: run via `npm run test:integration -- src/api/routes/roles.test.ts`.
describe.skipIf(!isIntegration)('Roles API (Integration)', () => {
  let adminApp: ElysiaLike;
  let userApp: ElysiaLike;
  const adminId = randomUUID();
  const userId = randomUUID();
  // ROLE_CONFIGS is a process-global singleton. `loadRolesFromDb()` below
  // overlays each entry with its DB row (DB-sourced toolIds and prompt), so
  // without restoring it this suite would leak the mutated config into unit
  // suites that assert the file-registry defaults
  // (e.g. core/agent/roles.test.ts). Snapshot the original entries and
  // restore them in afterAll.
  let roleConfigsBackup: Record<string, unknown> | null = null;

  beforeAll(async () => {
    await setupIntegrationDb();
    await truncateTables(['roles', 'users']);

    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    await seedUsers([
      { id: adminId, username: 'root', isAdmin: true },
      { id: userId, username: 'alice', isAdmin: false },
    ]);

    // Seed roles from the file registry into the DB + in-memory cache.
    const { seedRoles, loadRolesFromDb } = await import('@/db/seed-roles');
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    // Snapshot before mutating: loadRolesFromDb() replaces whole entries, so a
    // shallow copy of the original per-role objects is enough to restore.
    roleConfigsBackup = { ...ROLE_CONFIGS };
    await seedRoles();
    await loadRolesFromDb();

    const { roleRoutes } = await import('./roles');
    const { ANONYMOUS_PRINCIPAL, principalFromUser } = await import('@/security/principal');

    const buildApp = (uid: string | null, isAdmin: boolean): ElysiaLike =>
      new Elysia()
        .derive(() => {
          if (!uid) return { user: null, session: null, principal: ANONYMOUS_PRINCIPAL };
          const u = { id: uid, username: uid === adminId ? 'root' : 'alice', isAdmin };
          return { user: u, session: null, principal: principalFromUser(u) };
        })
        .group('/api', (a) => a.use(roleRoutes)) as unknown as ElysiaLike;

    adminApp = buildApp(adminId, true);
    userApp = buildApp(userId, false);
  });

  afterAll(async () => {
    // Restore the in-memory role registry so this suite's DB-sourced configs
    // don't leak into later unit suites.
    if (roleConfigsBackup) {
      const { ROLE_CONFIGS } = await import('@/core/agent/roles');
      // Delete first: this suite CREATES roles, and a key the snapshot never
      // had would otherwise survive into unit suites that count the registry.
      for (const key of Object.keys(ROLE_CONFIGS)) {
        if (!(key in roleConfigsBackup)) delete (ROLE_CONFIGS as Record<string, unknown>)[key];
      }
      for (const key of Object.keys(roleConfigsBackup)) {
        (ROLE_CONFIGS as Record<string, unknown>)[key] = roleConfigsBackup[key];
      }
    }
    await teardownIntegration();
  });

  async function patchJson(app: ElysiaLike, path: string, body: unknown) {
    const res = await app.handle(new Request(`http://localhost${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function send(app: ElysiaLike, method: string, path: string, body?: unknown) {
    const res = await app.handle(new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function get(app: ElysiaLike, path: string) {
    const res = await app.handle(new Request(`http://localhost${path}`));
    return { status: res.status, body: await res.json() };
  }

  test('loadRolesFromDb overlays the DB columns and keeps the rest of the registry', async () => {
    // It used to REBUILD each entry from the four columns the `roles` table
    // has, which dropped every field that table has no column for. Three of
    // those are load-bearing and all three were invisible to unit tests,
    // because unit tests never call this function: `readOnly` is the only
    // per-handler write filter in the system, `coreToolIds` is the entire
    // lazy-tool-discovery gate, and `liteSystemPromptTemplate` is what a small
    // model gets instead of the full prompt.
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    expect(ROLE_CONFIGS.review.readOnly).toBe(true);
    expect(ROLE_CONFIGS.general.coreToolIds?.length).toBeGreaterThan(0);
    expect(ROLE_CONFIGS.general.liteSystemPromptTemplate).toBeTruthy();
    // …and the DB still owns what it owns.
    expect(ROLE_CONFIGS.general.systemPromptTemplate).toBeTruthy();
  });

  test('non-admin cannot PATCH a role', async () => {
    const r = await patchJson(userApp, '/api/roles/general', { toolIds: ['filesystem'] });
    expect(r.status).toBe(403);
  });

  test('admin PATCH updates toolIds, marks customized, and GET reflects it', async () => {
    const r = await patchJson(adminApp, '/api/roles/general', { toolIds: ['filesystem', 'shell'] });
    expect(r.status).toBe(200);
    expect(r.body.toolIds).toEqual(['filesystem', 'shell']);
    expect(r.body.customized).toBe(true);

    const list = await get(adminApp, '/api/roles');
    const general = list.body.roles.find((x: any) => x.role === 'general');
    expect(general.toolIds).toEqual(['filesystem', 'shell']);
    expect(general.customized).toBe(true);
  });

  test('admin PATCH dedupes + trims toolIds', async () => {
    const r = await patchJson(adminApp, '/api/roles/general', { toolIds: ['filesystem', ' filesystem ', 'shell', ''] });
    expect(r.status).toBe(200);
    expect(r.body.toolIds).toEqual(['filesystem', 'shell']);
  });

  test('PATCH updates the in-memory ROLE_CONFIGS (spawn-time read point)', async () => {
    await patchJson(adminApp, '/api/roles/general', { toolIds: ['git'] });
    const { ROLE_CONFIGS } = await import('@/core/agent/roles');
    expect(ROLE_CONFIGS.general.toolIds).toEqual(['git']);
  });

  test('PATCH unknown role → 404', async () => {
    const r = await patchJson(adminApp, '/api/roles/does-not-exist', { toolIds: [] });
    expect(r.status).toBe(404);
  });

  test('PATCH with a non-array body is rejected (422)', async () => {
    const r = await patchJson(adminApp, '/api/roles/general', { toolIds: 'filesystem' });
    expect(r.status).toBe(422);
  });

  test('customized role survives a re-seed (user removal not re-added)', async () => {
    // Customize general to a single tool, then re-seed from code.
    await patchJson(adminApp, '/api/roles/general', { toolIds: ['filesystem'] });
    const { seedRoles } = await import('@/db/seed-roles');
    await seedRoles();
    const list = await get(adminApp, '/api/roles');
    const general = list.body.roles.find((x: any) => x.role === 'general');
    // Code config has many more tools; the customized row must NOT have them re-merged.
    expect(general.toolIds).toEqual(['filesystem']);
  });

  describe('user-defined roles', () => {
    // `AgentRole` is a closed union so a missing built-in stays a compile
    // error; a user's role is a name it cannot express.
    const userRole = (m: object) =>
      m as Record<string, { coreToolIds?: string[]; description?: string; criticalRules?: string[] }>;

    const NEW_ROLE = {
      role: 'translator',
      description: 'translate documents between languages',
      toolIds: ['filesystem', 'websearch'],
      coreToolIds: ['filesystem', 'not-granted'],
      defaultTopic: 'everyday',
      systemPromptTemplate: 'You translate documents.',
    };

    test('a retired role left in the table is not resurrected', async () => {
      // `orchestrator` was removed in Phase 9 and its row is still in every
      // database that predates it. A row with no folder is only a user's role
      // when it says so — otherwise it is a role that was deleted from the code.
      const db = getDb();
      await db.insert(roles).values({
        role: 'orchestrator',
        toolIds: ['shell'],
        defaultTopic: 'general',
        systemPromptTemplate: 'retired',
        isSystem: true,
      });
      const { loadRolesFromDb } = await import('@/db/seed-roles');
      await loadRolesFromDb();
      const { childRoles } = await import('@/core/swarm/swarm-tool');
      expect(childRoles()).not.toContain('orchestrator');
      await db.delete(roles).where(eq(roles.role, 'orchestrator'));
    });

    test('a created role joins the registry and becomes spawnable', async () => {
      const created = await send(adminApp, 'POST', '/api/roles', NEW_ROLE);
      expect(created.status).toBe(200);
      expect(created.body.lane).toBe('everyday');

      // The whole point: a role nothing can spawn is a role that does not
      // exist. It reaches the delegation menu through the live registry, so
      // the model can name it — there is no keyword table and no lane→role
      // lookup, the arrow only runs role → lane.
      const { childRoles, buildSpawnRoleCatalog } = await import('@/core/swarm/swarm-tool');
      expect(childRoles()).toContain('translator');
      expect(buildSpawnRoleCatalog()).toContain('- translator — translate documents between languages');

      // coreToolIds ⊆ toolIds is enforced on the way in, not only at load.
      const { ROLE_CONFIGS } = await import('@/core/agent/roles');
      expect(userRole(ROLE_CONFIGS).translator.coreToolIds).toEqual(['filesystem']);
      expect(userRole(ROLE_CONFIGS).translator.description).toBe(NEW_ROLE.description);
    });

    test('it is listed under its lane', async () => {
      const list = await get(adminApp, '/api/roles');
      const row = list.body.roles.find((x: any) => x.role === 'translator');
      expect(row.lane).toBe('everyday');
      expect(row.isSystem).toBe(false);
    });

    test('a duplicate name is refused', async () => {
      expect((await send(adminApp, 'POST', '/api/roles', NEW_ROLE)).status).toBe(409);
      expect((await send(adminApp, 'POST', '/api/roles', { ...NEW_ROLE, role: 'general' })).status).toBe(409);
    });

    test('a role with no prompt or no tools is refused', async () => {
      const bad = { ...NEW_ROLE, role: 'empty-one', toolIds: [] };
      expect((await send(adminApp, 'POST', '/api/roles', bad)).status).toBe(400);
      expect((await send(adminApp, 'POST', '/api/roles', { ...bad, toolIds: ['shell'], systemPromptTemplate: '  ' })).status).toBe(400);
    });

    test('a name that is not a usable identifier is refused', async () => {
      // It becomes a tool-enum value and a topic-path segment.
      for (const role of ['my role', '1st', 'x', 'a'.repeat(33), 'with.dot']) {
        expect((await send(adminApp, 'POST', '/api/roles', { ...NEW_ROLE, role })).status, role).toBe(400);
      }
      // Case is normalised, not rejected — which is why 'General' collides.
      expect((await send(adminApp, 'POST', '/api/roles', { ...NEW_ROLE, role: 'General' })).status).toBe(409);
    });

    test('a non-admin can neither create nor delete', async () => {
      expect((await send(userApp, 'POST', '/api/roles', { ...NEW_ROLE, role: 'sneaky' })).status).toBe(403);
      expect((await send(userApp, 'DELETE', '/api/roles/translator')).status).toBe(403);
    });

    test('a shipped role cannot be deleted — its folder would resurrect it', async () => {
      const r = await send(adminApp, 'DELETE', '/api/roles/general');
      expect(r.status).toBe(400);
      const { ROLE_CONFIGS } = await import('@/core/agent/roles');
      expect(ROLE_CONFIGS.general).toBeDefined();
    });

    test('clearing a field clears it in the live registry, not only in the DB', async () => {
      // The patch idiom turns "emptied" into `undefined`, and a spread of an
      // undefined value is a no-op — so this wrote the empty value to the
      // database and left the old one in ROLE_CONFIGS until the next restart,
      // which is the one thing the in-memory write exists to prevent.
      await send(adminApp, 'PATCH', '/api/roles/translator', { criticalRules: ['never guess a translation'] });
      const { ROLE_CONFIGS } = await import('@/core/agent/roles');
      expect(userRole(ROLE_CONFIGS).translator.criticalRules).toEqual(['never guess a translation']);

      await send(adminApp, 'PATCH', '/api/roles/translator', { criticalRules: [], description: '' });
      expect(userRole(ROLE_CONFIGS).translator.criticalRules).toBeUndefined();
      expect(userRole(ROLE_CONFIGS).translator.description).toBeUndefined();
    });

    test('an edit survives the next boot seed', async () => {
      // Only `toolIds` used to be guarded, so every other field was resynced
      // from the role's folder on every boot: an edited prompt, a flipped
      // read-only flag or a cleared rule list took effect until the next
      // restart and no further.
      await send(adminApp, 'PATCH', '/api/roles/coding', {
        systemPromptTemplate: 'You translate, actually.',
        readOnly: true,
        criticalRules: [],
      });
      const { seedRoles, loadRolesFromDb } = await import('@/db/seed-roles');
      await seedRoles();
      await loadRolesFromDb();

      const list = await get(adminApp, '/api/roles');
      const coding = list.body.roles.find((x: any) => x.role === 'coding');
      expect(coding.systemPromptTemplate).toBe('You translate, actually.');
      expect(coding.readOnly).toBe(true);
      expect(coding.criticalRules).toEqual([]);
    });

    test('a role cannot be bound to a lane that is not a text lane', async () => {
      // `embedding`/`vision`/`ocr` are model classes and `background` runs
      // memory extraction — a role on any of them resolves to a model that
      // cannot serve a tool-calling worker, so every spawn would fail.
      for (const defaultTopic of ['embedding', 'vision', 'ocr', 'background']) {
        const r = await send(adminApp, 'POST', '/api/roles', { ...NEW_ROLE, role: 'x-' + defaultTopic, defaultTopic });
        expect(r.status, defaultTopic).toBe(400);
      }
      expect((await send(adminApp, 'PATCH', '/api/roles/translator', { defaultTopic: 'embedding' })).status).toBe(400);
    });


    test('a non-admin does not see role prompts or standing rules', async () => {
      // The list is readable by anyone (the skills page assigns by role, the
      // pipeline editor picks one per step) but the prompt is what an operator
      // WROTE, and only an operator may read it back.
      const mine = await get(adminApp, '/api/roles');
      expect(mine.body.roles[0].systemPromptTemplate).toBeTruthy();
      const theirs = await get(userApp, '/api/roles');
      expect(theirs.status).toBe(200);
      expect(theirs.body.roles[0].role).toBeTruthy();
      for (const row of theirs.body.roles) {
        expect(row.systemPromptTemplate).toBeUndefined();
        expect(row.criticalRules).toBeUndefined();
      }
    });

    test('deleting a user role removes it from the registry too', async () => {
      expect((await send(adminApp, 'DELETE', '/api/roles/translator')).status).toBe(200);
      const { ROLE_CONFIGS } = await import('@/core/agent/roles');
      expect(userRole(ROLE_CONFIGS).translator).toBeUndefined();
      const { childRoles } = await import('@/core/swarm/swarm-tool');
      expect(childRoles()).not.toContain('translator');
      expect((await send(adminApp, 'DELETE', '/api/roles/translator')).status).toBe(404);
    });
  });
});

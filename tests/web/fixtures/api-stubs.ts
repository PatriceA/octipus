import type { Page, Route } from '@playwright/test';

/**
 * Reusable API route stubs — paths mirror the real Elysia routes in
 * `src/api/routes/*`. Every function installs handlers on the given page.
 *
 * The match patterns use glob-style `**\/api/<path>` because the browser
 * either hits `/api/...` (Next.js proxy) or `http://localhost:3005/api/...`.
 */

export function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export async function stubHealth(page: Page): Promise<void> {
  await page.route('**/api/health/**', (route) =>
    json(route, 200, { status: 'ok', timestamp: new Date().toISOString() }),
  );
}

export async function stubSessions(page: Page): Promise<void> {
  // List sessions
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() === 'GET') {
      return json(route, 200, {
        sessions: [
          {
            id: 'sess-1',
            title: 'First chat',
            status: 'active',
            updatedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 3,
          },
          {
            id: 'sess-2',
            title: 'Second chat',
            status: 'active',
            updatedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            messageCount: 1,
          },
        ],
      });
    }
    if (route.request().method() === 'POST') {
      return json(route, 200, {
        id: 'sess-new',
        title: 'New chat',
        createdAt: new Date().toISOString(),
      });
    }
    return json(route, 200, {});
  });

  // Messages for a session
  await page.route('**/api/sessions/*/messages', (route) =>
    json(route, 200, { messages: [] }),
  );

  // Delete / update specific session
  await page.route('**/api/sessions/*', (route) => {
    if (route.request().method() === 'DELETE') return json(route, 200, { ok: true });
    return json(route, 200, {
      id: 'sess-1',
      title: 'First chat',
      context: {},
    });
  });
}

export async function stubModels(page: Page): Promise<void> {
  let models = [
    { id: 'm1', name: 'gpt-4o', provider: 'openai', isDefault: true, topic: 'coding' },
    { id: 'm2', name: 'claude-3-5-sonnet', provider: 'anthropic', isDefault: false, topic: 'research' },
  ];

  await page.route('**/api/models', (route) => {
    const req = route.request();
    if (req.method() === 'GET') return json(route, 200, { models });
    if (req.method() === 'POST') {
      const added = { id: `m${models.length + 1}`, name: 'new-model', provider: 'openai', isDefault: false };
      models.push(added);
      return json(route, 200, { model: added });
    }
    return json(route, 200, {});
  });
  await page.route('**/api/models/**', (route) => {
    if (route.request().method() === 'DELETE') {
      models = models.slice(0, -1);
      return json(route, 200, { ok: true });
    }
    if (route.request().method() === 'POST') return json(route, 200, { ok: true });
    return json(route, 200, {});
  });
}

/**
 * Notes workspace: list/index/tags plus a stand-in for the documents upload
 * that backs pasted images, and the `/raw` read-back the preview performs.
 */
export async function stubNotes(page: Page): Promise<void> {
  // Mirrors src/api/routes/notes.ts: `noteKind` (not `kind`), and GET /notes/:id
  // returns the note itself spread with `backlinks`/`outgoing` — NOT wrapped in
  // a `{ note }` envelope. A stub that drifts from the route teaches the suite
  // to pass against a shape the server never sends.
  const notes = [
    {
      id: 'n1',
      slug: 'first-note',
      title: 'First note',
      noteKind: 'note',
      tags: ['demo'],
      pinned: false,
      updatedAt: '2026-01-01T00:00:00Z',
      noteDate: null,
    },
  ];
  // One handler branching on pathname: glob routes treat `?` as a wildcard, so
  // `**/api/notes?**` does not reliably distinguish the list call from
  // `/notes/index`. Matching on the parsed path removes the ambiguity.
  await page.route(/\/api\/notes(\/|\?|$)/, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/notes/, '') || '/';
    if (path.startsWith('/index')) {
      return json(route, 200, {
        notes: notes.map((n) => ({ id: n.id, slug: n.slug, title: n.title, noteKind: n.noteKind })),
        total: notes.length,
      });
    }
    if (path.startsWith('/tags')) return json(route, 200, { tags: [{ tag: 'demo', count: 1 }] });
    if (path.includes('/suggestions')) return json(route, 200, { suggestions: [] });
    if (path.startsWith('/n1')) {
      return json(route, 200, {
        ...notes[0],
        body: '# First note\n\nbody text\n',
        frontmatter: {},
        backlinks: [],
        outgoing: [],
      });
    }
    return json(route, 200, { notes, total: notes.length });
  });

  // A 1x1 PNG — enough for the object-URL round trip.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.route('**/api/documents/upload', (route) =>
    json(route, 200, { uploaded: [{ id: 'doc-img-1', filename: 'pasted.png', status: 'queued' }] }),
  );
  await page.route('**/api/documents/doc-img-1/raw**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  );
}

/**
 * Topic → model bindings. The Models page reads these (OrchestratorModelNote
 * shows which lane the root agent resolves), so leaving `/api/topics`
 * unstubbed meant the page rendered against a body with no `topics` array.
 */
export async function stubTopics(page: Page): Promise<void> {
  await page.route('**/api/topics', (route) =>
    json(route, 200, {
      topics: [
        { value: 'chat', label: 'chat', primaryModel: 'gpt-4o', backupModel: null, executorModel: null },
        { value: 'coding', label: 'coding', primaryModel: 'claude-3-5-sonnet', backupModel: null, executorModel: null },
      ],
    }),
  );
}

export async function stubExperts(page: Page): Promise<void> {
  const experts = [
    {
      id: 'exp-coder',
      name: 'Coder',
      description: 'Writes and refactors code',
      role: 'coding',
      icon: 'code',
      isSystem: true,
    },
    {
      id: 'exp-researcher',
      name: 'Researcher',
      description: 'Does research',
      role: 'research',
      icon: 'search',
      isSystem: true,
    },
    {
      id: 'exp-custom',
      name: 'MyCustom',
      description: 'Custom line one\nCustom line two',
      role: 'general',
      icon: 'bot',
      isSystem: false,
    },
  ];

  await page.route('**/api/experts', (route) => {
    const req = route.request();
    if (req.method() === 'GET') return json(route, 200, { experts });
    if (req.method() === 'POST') {
      return json(route, 200, {
        id: 'exp-new',
        name: 'New Expert',
        description: 'd',
        role: 'general',
      });
    }
    return json(route, 200, {});
  });
  await page.route('**/api/experts/*', (route) => {
    if (route.request().method() === 'DELETE') return json(route, 200, { deleted: true });
    if (route.request().method() === 'PATCH') return json(route, 200, { id: 'exp-custom', name: 'Updated' });
    return json(route, 200, experts[0]);
  });
}

export async function stubMcp(page: Page, circuitState: 'closed' | 'open' | 'half_open' = 'closed'): Promise<void> {
  await page.route('**/api/mcp/servers', (route) =>
    json(route, 200, {
      servers: [
        {
          id: 'filesystem',
          name: 'filesystem',
          transport: 'stdio',
          status: 'connected',
          isEnabled: true,
          toolCount: 8,
        },
        {
          id: 'github',
          name: 'github',
          transport: 'stdio',
          status: 'disconnected',
          isEnabled: false,
          toolCount: 12,
        },
      ],
    }),
  );
  // Matches real response shape: { circuits: [...] }
  await page.route('**/api/mcp/circuit', (route) =>
    json(route, 200, {
      circuits: [
        {
          serverId: 'filesystem',
          state: circuitState,
          failureCount: circuitState === 'closed' ? 0 : 5,
          cooldownRemainingMs: circuitState === 'open' ? 30_000 : 0,
        },
      ],
    }),
  );
  await page.route('**/api/mcp/circuit/*/reset', (route) =>
    json(route, 200, { reset: true }),
  );
  await page.route('**/api/mcp/servers/*/**', (route) => json(route, 200, { ok: true }));
  await page.route('**/api/mcp/tools', (route) => json(route, 200, { tools: [] }));
}

export async function stubKnowledge(page: Page, opts: { ready?: boolean } = {}): Promise<void> {
  const ready = opts.ready !== false;
  // Real endpoint is /readiness, not /ready
  await page.route('**/api/knowledge/readiness', (route) =>
    route.fulfill({
      status: ready ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(
        ready
          ? { ready: true, checks: { db: 'ok', embedding: 'ok', vectorStore: 'ok' } }
          : { ready: false, reason: 'embedding model initializing' },
      ),
    }),
  );
  // List entries
  await page.route('**/api/knowledge', (route) =>
    json(route, 200, { entries: [], total: 0 }),
  );
  await page.route('**/api/knowledge/stats', (route) =>
    json(route, 200, { total: 0, bySourceType: {}, models: [] }),
  );
  await page.route('**/api/knowledge/search', (route) => {
    const body = route.request().postDataJSON() as { query?: string } | null;
    const query = body?.query || '';
    if (!query || query === 'nomatch') return json(route, 200, { results: [] });
    return json(route, 200, {
      results: [{ id: 'r1', score: 0.91, excerpt: `Matching excerpt for ${query}`, source: 'readme.txt' }],
    });
  });
  await page.route('**/api/knowledge/index', (route) =>
    json(route, 200, { indexed: 1 }),
  );
}

export async function stubSkills(page: Page): Promise<void> {
  await page.route('**/api/skills', (route) =>
    json(route, 200, {
      skills: [
        { id: 's1', name: 'refactor', description: 'Refactor code', category: 'coding', isSystem: true },
        { id: 's2', name: 'explain', description: 'Explain code', category: 'coding', isSystem: true },
      ],
    }),
  );
  await page.route('**/api/skills/topics**', (route) => json(route, 200, { assignments: [] }));
  await page.route('**/api/skills/proposals', (route) => {
    if (route.request().method() === 'GET') {
      return json(route, 200, {
        proposals: [
          {
            id: 'p1',
            name: 'auto-test',
            description: 'Generates tests',
            draftPromptTemplate: 'Prompt',
            exemplarCount: 3,
            lastExemplarAt: new Date().toISOString(),
            status: 'pending',
          },
        ],
      });
    }
    return json(route, 200, { ok: true });
  });
  await page.route('**/api/skills/proposals/*/approve', (route) => json(route, 200, { promoted: true }));
  await page.route('**/api/skills/proposals/*/reject', (route) => json(route, 200, { rejected: true }));
}

export async function stubPipelines(page: Page): Promise<void> {
  await page.route('**/api/pipelines/templates', (route) => {
    if (route.request().method() === 'GET') {
      return json(route, 200, {
        templates: [
          { id: 't1', name: 'build-and-test', description: 'CI pipeline', isPreset: true, stageCount: 3 },
          { id: 't2', name: 'release', description: 'Release pipeline', isPreset: false, stageCount: 2 },
        ],
      });
    }
    return json(route, 200, { ok: true });
  });
  await page.route('**/api/pipelines/templates/*', (route) => json(route, 200, { ok: true }));
  await page.route('**/api/pipelines**', (route) => {
    if (route.request().method() === 'POST') {
      return json(route, 200, { run: { id: 'run-new', status: 'queued' } });
    }
    return json(route, 200, { runs: [{ id: 'run-1', status: 'done', templateId: 't1' }] });
  });
}

export async function stubSwarm(page: Page): Promise<void> {
  // Real API returns swarm_nodes rows
  await page.route('**/api/swarm/nodes**', (route) => {
    const req = route.request();
    if (req.method() === 'POST') return json(route, 200, { cancelled: true });
    return json(route, 200, {
      nodes: [
        {
          id: 'n1',
          rootSessionId: 'sess-1',
          parentNodeId: null,
          // `root`/`general`, matching what the backend writes since the root
          // agent became an ordinary worker. The stale 'rootAgent' kind made
          // the tree render the root as a child node — so the root-only
          // "cancel swarm" button never appeared and its test failed.
          kind: 'root',
          depth: 0,
          role: 'general',
          topicPath: 'root',
          model: 'gpt-4o',
          status: 'running',
          tokensUsed: 150,
          tokenCap: 200_000,
          fanOutUsed: 1,
          fanOutCap: 6,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'n2',
          rootSessionId: 'sess-1',
          parentNodeId: 'n1',
          kind: 'agent',
          depth: 1,
          role: 'coding',
          topicPath: 'root/coding',
          model: 'gpt-4o',
          status: 'completed',
          tokensUsed: 80,
          tokenCap: 80_000,
          fanOutUsed: 0,
          fanOutCap: 4,
          createdAt: new Date().toISOString(),
        },
      ],
    });
  });
  await page.route('**/api/swarm/nodes/*/cancel', (route) => json(route, 200, { cancelled: true }));
}

export async function stubSettings(page: Page): Promise<void> {
  await page.route('**/api/settings', (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return json(route, 200, {
        theme: 'dark',
        topicMap: { coding: 'gpt-4o', research: 'claude-3-5-sonnet' },
      });
    }
    return json(route, 200, { ok: true });
  });
  await page.route('**/api/settings/**', (route) => json(route, 200, {}));
  await page.route('**/api/permissions**', (route) => json(route, 200, { permissions: [] }));
}

export async function stubTools(page: Page): Promise<void> {
  await page.route('**/api/tools', (route) =>
    json(route, 200, {
      tools: [
        { id: 'shell', name: 'Shell', description: 'Run shell commands', version: '1.0.0' },
        { id: 'filesystem', name: 'Filesystem', description: 'Read/write files', version: '1.0.0' },
      ],
    }),
  );
  await page.route('**/api/tools/permissions**', (route) => json(route, 200, { permissions: [] }));
}

export async function stubHooks(page: Page): Promise<void> {
  await page.route('**/api/hooks', (route) => json(route, 200, { hooks: [] }));
  await page.route('**/api/hooks/**', (route) => json(route, 200, {}));
  await page.route('**/api/recurring-tasks', (route) => json(route, 200, { tasks: [] }));
  await page.route('**/api/recurring-tasks/**', (route) => json(route, 200, {}));
}

export async function stubAgents(page: Page): Promise<void> {
  await page.route('**/api/agents**', (route) => json(route, 200, { agents: [] }));
}

export async function stubDocuments(page: Page): Promise<void> {
  await page.route('**/api/documents**', (route) => json(route, 200, { documents: [] }));
}

export async function stubVault(page: Page): Promise<void> {
  await page.route('**/api/vault', (route) => json(route, 200, { entries: [] }));
  await page.route('**/api/vault/**', (route) => json(route, 200, {}));
}

export async function stubEvaluations(page: Page): Promise<void> {
  await page.route('**/api/evaluations**', (route) => json(route, 200, { evaluations: [] }));
  await page.route('**/api/eval**', (route) => json(route, 200, { results: [] }));
}

export async function stubProfiles(page: Page): Promise<void> {
  await page.route('**/api/profiles**', (route) => json(route, 200, { profiles: [] }));
}

/**
 * Install the full default set. Individual tests can override specific routes
 * after this call because Playwright's `page.route` matches in reverse order
 * of registration (last registered wins).
 */
export async function stubWorkspaces(page: Page): Promise<void> {
  const now = new Date().toISOString();
  // The app shell (WorkspaceProvider) fetches these on every page and calls
  // `.find()` on the result, so an unstubbed `{}` from the catch-all crashes
  // every route into the error boundary.
  await page.route('**/api/me/workspaces', (route) =>
    json(route, 200, {
      workspaces: [
        { id: 'ws-1', userId: 'e2e-user-id', slug: 'default', name: 'Default', isDefault: true, createdAt: now, updatedAt: now },
      ],
    }),
  );
  await page.route('**/api/me/orgs', (route) => json(route, 200, { orgs: [] }));
}

export async function stubAllDefaults(page: Page): Promise<void> {
  await stubWorkspaces(page);
  await stubHealth(page);
  await stubSessions(page);
  await stubModels(page);
  await stubTopics(page);
  await stubExperts(page);
  await stubMcp(page);
  await stubKnowledge(page);
  await stubSkills(page);
  await stubPipelines(page);
  await stubSwarm(page);
  await stubSettings(page);
  await stubTools(page);
  await stubHooks(page);
  await stubAgents(page);
  await stubDocuments(page);
  await stubVault(page);
  await stubEvaluations(page);
  await stubProfiles(page);
  // AFTER stubDocuments on purpose: Playwright tries the most recently
  // registered route first, and stubDocuments' `**/api/documents**` catch-all
  // would otherwise answer the image upload with `{documents: []}`.
  await stubNotes(page);
}

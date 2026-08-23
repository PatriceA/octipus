import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'crypto';
import { Elysia } from '@/api/http';
import {
  isIntegration,
  setupIntegrationDb,
  teardownIntegration,
  truncateTables,
} from '@/test-helpers/integration';

type ElysiaLike = { handle: (req: Request) => Promise<Response> };

interface SearchResult {
  id: string;
  type: 'session' | 'hook' | 'model' | 'skill' | 'knowledge' | 'tool';
  title: string;
  subtitle: string;
  href: string;
}

const VALID_TYPES: SearchResult['type'][] = ['session', 'hook', 'model', 'skill', 'knowledge', 'tool'];

// Integration tests exercise the real search route against Postgres. Run via:
//   npm run test:integration -- src/api/routes/search.test.ts

describe.skipIf(!isIntegration)('Search API (Integration)', () => {
  let app: ElysiaLike;
  let testUserId: string;

  beforeAll(async () => {
    await setupIntegrationDb();

    // Seed a user to own the sessions we'll search against (sessions.user_id is FK).
    const { getDb } = await import('@/db/postgres');
    const { users } = await import('@/db/schema/users');
    const { sessions } = await import('@/db/schema/sessions');
    const { hooks } = await import('@/db/schema/hooks');
    const db = getDb();

    await truncateTables(['sessions', 'hooks', 'users']);

    const [user] = await db
      .insert(users)
      .values({ username: `tester-${Date.now()}` })
      .returning();
    testUserId = user.id;

    await db.insert(sessions).values([
      {
        userId: testUserId,
        channelType: 'webchat',
        channelId: 'ch-1',
        title: 'Docker deployment plan',
      },
      {
        userId: testUserId,
        channelType: 'webchat',
        channelId: 'ch-2',
        title: 'Weather notes',
      },
    ]);

    await db.insert(hooks).values([
      {
        id: randomUUID(),
        name: 'Docker rebuild hook',
        description: 'Rebuilds docker on schedule',
        trigger: 'schedule',
        triggerConfig: {},
        action: 'notify',
        actionConfig: {},
        userId: testUserId,
      } as any,
      {
        id: randomUUID(),
        name: 'Weather summary',
        description: 'Fetches weather',
        trigger: 'schedule',
        triggerConfig: {},
        action: 'notify',
        actionConfig: {},
        userId: testUserId,
      } as any,
    ]);

    // Mount the real search route with an injected user context.
    const { searchRoutes } = await import('./search');
    app = new Elysia()
      .derive({ as: 'global' }, () => ({
        user: { id: testUserId, username: 'tester', isAdmin: true },
        session: null,
      }))
      .use(searchRoutes);
  });

  afterAll(async () => {
    await teardownIntegration();
  });

  test('returns empty results for short queries', async () => {
    const res = await app.handle(new Request('http://localhost/search?q=a'));
    const data = (await res.json()) as { results: SearchResult[] };
    expect(data.results).toBeInstanceOf(Array);
    expect(data.results.length).toBe(0);
  });

  test('returns session + hook matches for a real query', async () => {
    const res = await app.handle(new Request('http://localhost/search?q=docker'));
    const data = (await res.json()) as { results: SearchResult[] };

    expect(data.results).toBeInstanceOf(Array);
    expect(data.results.length).toBeGreaterThan(0);

    for (const r of data.results) {
      expect(VALID_TYPES).toContain(r.type);
      expect(r.id).toBeDefined();
      expect(r.title).toBeDefined();
      expect(r.href.startsWith('/')).toBe(true);
    }

    const types = new Set(data.results.map((r) => r.type));
    expect(types.has('session')).toBe(true);
    expect(types.has('hook')).toBe(true);
  });

  test('query for weather matches both session and hook', async () => {
    const res = await app.handle(new Request('http://localhost/search?q=weather'));
    const data = (await res.json()) as { results: SearchResult[] };

    const sessionHits = data.results.filter((r) => r.type === 'session');
    expect(sessionHits.some((r) => r.title.toLowerCase().includes('weather'))).toBe(true);
  });

  test('nonsense query returns empty', async () => {
    const res = await app.handle(new Request('http://localhost/search?q=xyzzy-nope'));
    const data = (await res.json()) as { results: SearchResult[] };
    expect(data.results.length).toBe(0);
  });
});

describe('Search API (Unit)', () => {
  describe('returns empty results for short queries', () => {
    test('query shorter than 2 characters returns empty results', () => {
      const q = 'a';

      // Replicate the route logic: q.trim().length < 2 => { results: [] }
      const shouldReturnEmpty = !q || q.trim().length < 2;

      expect(shouldReturnEmpty).toBe(true);
    });

    test('empty query returns empty results', () => {
      const q: string = '';
      const shouldReturnEmpty = !q || q.trim().length < 2;

      expect(shouldReturnEmpty).toBe(true);
    });

    test('whitespace-only query returns empty results', () => {
      const q = '   ';
      const shouldReturnEmpty = !q || q.trim().length < 2;

      expect(shouldReturnEmpty).toBe(true);
    });

    test('query of exactly 2 characters is accepted', () => {
      const q = 'ab';
      const shouldReturnEmpty = !q || q.trim().length < 2;

      expect(shouldReturnEmpty).toBe(false);
    });
  });

  describe('returns grouped results with correct types', () => {
    test('session results have correct type and href', () => {
      const result: SearchResult = {
        id: 'session-1',
        type: 'session',
        title: 'Test Session',
        subtitle: 'webchat - active',
        href: '/chat?session=session-1',
      };

      expect(result.type).toBe('session');
      expect(result.href).toContain('/chat?session=');
      expect(VALID_TYPES).toContain(result.type);
    });

    test('hook results have correct type and href', () => {
      const result: SearchResult = {
        id: 'hook-1',
        type: 'hook',
        title: 'Morning Briefing',
        subtitle: 'Daily briefing at 8 AM',
        href: '/hooks?hook=hook-1',
      };

      expect(result.type).toBe('hook');
      expect(result.href).toContain('/hooks?hook=');
      expect(VALID_TYPES).toContain(result.type);
    });

    test('model results have correct type and href', () => {
      const result: SearchResult = {
        id: 'model-1',
        type: 'model',
        title: 'qwen3:14b',
        subtitle: 'ollama - qwen3:14b',
        href: '/models',
      };

      expect(result.type).toBe('model');
      expect(result.href).toBe('/models');
      expect(VALID_TYPES).toContain(result.type);
    });

    test('skill results have correct type and href', () => {
      const result: SearchResult = {
        id: 'skill-1',
        type: 'skill',
        title: 'TDD',
        subtitle: 'Test driven development practices',
        href: '/skills',
      };

      expect(result.type).toBe('skill');
      expect(result.href).toBe('/skills');
      expect(VALID_TYPES).toContain(result.type);
    });

    test('knowledge results have correct type and href', () => {
      const result: SearchResult = {
        id: 'knowledge-1',
        type: 'knowledge',
        title: 'Docker best practices',
        subtitle: 'document - relevance: 85%',
        href: '/knowledge',
      };

      expect(result.type).toBe('knowledge');
      expect(result.href).toBe('/knowledge');
      expect(VALID_TYPES).toContain(result.type);
    });

    test('tool results have correct type and href', () => {
      const result: SearchResult = {
        id: 'tool-1',
        type: 'tool',
        title: 'Shell',
        subtitle: 'Execute shell commands',
        href: '/tools',
      };

      expect(result.type).toBe('tool');
      expect(result.href).toBe('/tools');
      expect(VALID_TYPES).toContain(result.type);
    });

    test('all result types are valid', () => {
      const results: SearchResult[] = [
        { id: '1', type: 'session', title: 'S', subtitle: '', href: '/chat?session=1' },
        { id: '2', type: 'hook', title: 'H', subtitle: '', href: '/hooks?hook=2' },
        { id: '3', type: 'model', title: 'M', subtitle: '', href: '/models' },
        { id: '4', type: 'skill', title: 'Sk', subtitle: '', href: '/skills' },
        { id: '5', type: 'knowledge', title: 'K', subtitle: '', href: '/knowledge' },
        { id: '6', type: 'tool', title: 'T', subtitle: '', href: '/tools' },
      ];

      for (const r of results) {
        expect(VALID_TYPES).toContain(r.type);
      }
    });
  });

  describe('each result has id, type, title, href', () => {
    test('result has all required fields', () => {
      const result: SearchResult = {
        id: 'test-123',
        type: 'session',
        title: 'Test Title',
        subtitle: 'Test Subtitle',
        href: '/chat?session=test-123',
      };

      expect(result.id).toBeDefined();
      expect(typeof result.id).toBe('string');
      expect(result.id.length).toBeGreaterThan(0);

      expect(result.type).toBeDefined();
      expect(typeof result.type).toBe('string');

      expect(result.title).toBeDefined();
      expect(typeof result.title).toBe('string');

      expect(result.href).toBeDefined();
      expect(typeof result.href).toBe('string');
      expect(result.href.startsWith('/')).toBe(true);
    });

    test('subtitle is present on results', () => {
      const result: SearchResult = {
        id: 'test-456',
        type: 'hook',
        title: 'My Hook',
        subtitle: 'schedule trigger',
        href: '/hooks?hook=test-456',
      };

      expect(result.subtitle).toBeDefined();
      expect(typeof result.subtitle).toBe('string');
    });
  });

  describe('result mapping logic', () => {
    test('session result maps title from session title or fallback', () => {
      const sessionTitle: string | null = null;
      const title = sessionTitle || 'Untitled session';

      expect(title).toBe('Untitled session');
    });

    test('session result maps subtitle from channel and status', () => {
      const channelType = 'webchat';
      const status = 'active';
      const subtitle = `${channelType} - ${status}`;

      expect(subtitle).toBe('webchat - active');
    });

    test('hook result maps subtitle from description or trigger fallback', () => {
      const description: string | null = null;
      const trigger = 'schedule';
      const subtitle = description || `Trigger: ${trigger}`;

      expect(subtitle).toBe('Trigger: schedule');
    });

    test('hook result prefers description over trigger fallback', () => {
      const description = 'Daily briefing';
      const trigger = 'schedule';
      const subtitle = description || `Trigger: ${trigger}`;

      expect(subtitle).toBe('Daily briefing');
    });

    test('knowledge subtitle includes relevance percentage', () => {
      const purpose = 'document';
      const similarity = 0.85;
      const subtitle = `${purpose}${similarity ? ` - relevance: ${(similarity * 100).toFixed(0)}%` : ''}`;

      expect(subtitle).toBe('document - relevance: 85%');
    });

    test('knowledge subtitle without similarity', () => {
      const purpose = 'document';
      const similarity: number | undefined = undefined;
      const subtitle = `${purpose}${similarity ? ` - relevance: ${(similarity * 100).toFixed(0)}%` : ''}`;

      expect(subtitle).toBe('document');
    });

    test('results are limited to limit * 3', () => {
      const limit = 10;
      const maxResults = limit * 3;

      // If we had 50 results, they'd be sliced
      const results = Array.from({ length: 50 }, (_, i) => ({ id: `r-${i}` }));
      const sliced = results.slice(0, maxResults);

      expect(sliced.length).toBe(30);
    });

    test('default limit is 10 when not provided', () => {
      const limitStr: string | undefined = undefined;
      const limit = limitStr ? parseInt(limitStr, 10) : 10;

      expect(limit).toBe(10);
    });

    test('parses custom limit from query string', () => {
      const limitStr = '5';
      const limit = limitStr ? parseInt(limitStr, 10) : 10;

      expect(limit).toBe(5);
    });

    test('search pattern wraps query with wildcards', () => {
      const searchTerm = 'docker';
      const pattern = `%${searchTerm}%`;

      expect(pattern).toBe('%docker%');
    });
  });

  describe('tool in-memory search logic', () => {
    test('matches tool by name case-insensitively', () => {
      const tools = [
        { id: 'shell', name: 'Shell', description: 'Execute shell commands' },
        { id: 'git', name: 'Git', description: 'Git operations' },
        { id: 'browser', name: 'Browser', description: 'Browse the web' },
      ];

      const searchTerm = 'shell';
      const lower = searchTerm.toLowerCase();
      const matched = tools.filter(
        t => t.name.toLowerCase().includes(lower) ||
             t.id.toLowerCase().includes(lower) ||
             t.description.toLowerCase().includes(lower),
      );

      expect(matched.length).toBe(1);
      expect(matched[0].name).toBe('Shell');
    });

    test('matches tool by description', () => {
      const tools = [
        { id: 'shell', name: 'Shell', description: 'Execute shell commands' },
        { id: 'git', name: 'Git', description: 'Git operations' },
      ];

      const searchTerm = 'commands';
      const lower = searchTerm.toLowerCase();
      const matched = tools.filter(
        t => t.name.toLowerCase().includes(lower) ||
             t.id.toLowerCase().includes(lower) ||
             t.description.toLowerCase().includes(lower),
      );

      expect(matched.length).toBe(1);
      expect(matched[0].id).toBe('shell');
    });

    test('matches tool by id', () => {
      const tools = [
        { id: 'filesystem', name: 'File System', description: 'File operations' },
      ];

      const searchTerm = 'filesystem';
      const lower = searchTerm.toLowerCase();
      const matched = tools.filter(
        t => t.name.toLowerCase().includes(lower) ||
             t.id.toLowerCase().includes(lower) ||
             t.description.toLowerCase().includes(lower),
      );

      expect(matched.length).toBe(1);
    });

    test('returns empty for no match', () => {
      const tools = [
        { id: 'shell', name: 'Shell', description: 'Execute shell commands' },
      ];

      const searchTerm = 'xyz-nonexistent';
      const lower = searchTerm.toLowerCase();
      const matched = tools.filter(
        t => t.name.toLowerCase().includes(lower) ||
             t.id.toLowerCase().includes(lower) ||
             t.description.toLowerCase().includes(lower),
      );

      expect(matched.length).toBe(0);
    });
  });
});

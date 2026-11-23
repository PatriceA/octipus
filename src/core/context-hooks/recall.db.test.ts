/**
 * Recall over embedded PGlite with a deterministic embedding stand-in
 * (src/test-helpers/fake-embedding.ts), so the vector leg runs: which
 * passages qualify, which are shown, what showing them does, and how a later
 * turn of the conversation leaves out a passage still in view.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentMessage } from '@/core/types';
import type { ContextHookRunRecord } from '@/db/schema/context-hooks';
import { fakeEmbedder, vectorLiteral } from '@/test-helpers/fake-embedding';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const userId = '77777777-7777-7777-7777-777777777777';
let queryRaw: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
let executeRaw: (sql: string) => Promise<unknown>;

// The stand-in knows these words mean the same; nothing else is a synonym.
const embed = fakeEmbedder({ aliases: { charge: 'price', charges: 'price', pricing: 'price', costs: 'price', cost: 'price' } });

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-recall-'));
  const pg = await import('@/db/postgres');
  await pg.initializeDb();
  queryRaw = pg.queryRaw as typeof queryRaw;
  executeRaw = pg.executeRaw as typeof executeRaw;
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  await executeRaw(`INSERT INTO users (id, username, is_admin) VALUES ('${userId}', 'rena', false) ON CONFLICT DO NOTHING`);
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  await executeRaw('DELETE FROM context_hooks; DELETE FROM context_turns; DELETE FROM notes; DELETE FROM embeddings;');
  const { resetNotesIndexCache } = await import('@/core/context-hooks/kinds');
  resetNotesIndexCache();
  const { resetSessionLevels } = await import('@/core/protection/session-level');
  resetSessionLevels();
  const { getEmbeddingService } = await import('@/core/rag/embeddings');
  vi.spyOn(getEmbeddingService(), 'generateEmbedding').mockImplementation(async (text: string) => embed(text));
  // Only recall here: the notes index has its own suite.
  const { updateContextHook } = await import('@/core/context-hooks');
  await updateContextHook(userId, 'builtin:notes-index', { enabled: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // recordAccess is fire-and-forget: let it land before the next test clears the table.
  await accessSettled();
});

/**
 * Wait for the access counts already asked for. countAccess reaches
 * recordAccess after a dynamic import of a loaded module (microtasks only),
 * and its UPDATE is then queued on the one PGlite connection ahead of any
 * query sent after this: a macrotask later, a read sees every count asked
 * for so far. No wall-clock wait.
 */
const accessSettled = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A knowledge-base chunk embedded by the stand-in. A `doc:` source has no document row: its level reads as unclear. */
async function chunk(title: string, content: string, opts: { source?: string; purpose?: 'note' | 'lesson' | 'document' } = {}) {
  const id = randomUUID();
  await queryRaw(
    `INSERT INTO embeddings (id, source_id, content, model, embedding, purpose, content_sha256, embedding_version, user_id, metadata)
     VALUES ($1, $2, $3, 'fake', $4, $5, $6, 'fake/512', $7, $8)`,
    [id, opts.source ?? `note:${randomUUID()}`, content, vectorLiteral(embed(content)), opts.purpose ?? 'note', randomUUID(), userId, JSON.stringify({ title })],
  );
  return id;
}

async function run(query: string, extra: { previousMessage?: string; sessionId?: string } = {}) {
  const { runContextHooks } = await import('@/core/context-hooks');
  return runContextHooks({ event: 'turn_start', userId, workspaceId: null, sessionId: extra.sessionId ?? 'sess-recall', query, role: 'general', channel: 'web', ...(extra.previousMessage ? { previousMessage: extra.previousMessage } : {}) });
}

async function lastRecord(): Promise<ContextHookRunRecord> {
  const { rows } = await queryRaw('SELECT hooks FROM context_turns ORDER BY created_at DESC LIMIT 1');
  const hooks = rows[0].hooks as ContextHookRunRecord[];
  return hooks.find((h) => h.kind === 'recall') as ContextHookRunRecord;
}

async function accessCounts(): Promise<Record<string, number>> {
  await accessSettled();
  const { rows } = await queryRaw('SELECT id, access_count FROM embeddings');
  return Object.fromEntries(rows.map((r) => [r.id as string, Number(r.access_count)]));
}

describe('the any-term keyword mode of hybrid search', () => {
  const scope = { kind: 'personal' as const, userId, workspaceId: null };

  test('finds a passage sharing one word of a sentence, with its evidence; the default mode still needs every word', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const service = getEmbeddingService();
    vi.mocked(service.generateEmbedding).mockRejectedValue(new Error('provider down'));
    const id = await chunk('Pricing', "Pricing: a five-page website costs 2400 euro. O'Reilly's back\\slash quote.");
    const any = await service.hybridSearchAnyTerm(scope, 'What do we charge for a website?', 5);
    expect(any.embeddingError).toBe('provider down');
    expect(any.queryLexemes.sort()).toEqual(['charg', 'websit']);
    expect(any.candidates.map((c) => [c.id, c.cosine, c.matchedLexemes])).toEqual([[id, null, ['websit']]]);
    // Lexemes with quotes and backslashes do not break the query.
    expect((await service.hybridSearchAnyTerm(scope, "o'reilly back\\slash", 5)).candidates).toHaveLength(1);
    // Only stopwords: no keyword candidate, no error.
    expect((await service.hybridSearchAnyTerm(scope, 'what is it?', 5)).candidates).toEqual([]);
    // search_knowledge's mode is unchanged: every word, so the sentence finds nothing.
    expect(await service.hybridSearch(scope, 'What do we charge for a website?', 5, undefined, 0.6, 0.3, { skipAccess: true })).toEqual([]);
  });

  test('with an embedding, every candidate carries its cosine', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    await chunk('Pricing', 'Pricing: a website costs 2400 euro.');
    const any = await getEmbeddingService().hybridSearchAnyTerm(scope, 'What do we charge for a website?', 5);
    expect(any.embeddingError).toBeNull();
    expect(any.candidates).toHaveLength(1);
    expect(any.candidates[0].cosine).toBeCloseTo(0.707, 2);
    expect(any.candidates[0].similarity).toBe(any.candidates[0].cosine);
  });
});

describe('which passages qualify', () => {
  test('a paraphrased question is recalled through the vector leg; one shared keyword would not have done it', async () => {
    await chunk('Pricing', 'Pricing: a website costs 2400 euro.');
    await chunk('Holiday hours', 'The studio closes from 24 December to 2 January for the holidays.');
    const { text } = await run('What do we charge for a website?');
    expect(text).toContain('Note "Pricing"');
    expect(text).toContain('2400 euro');
    expect(text).not.toContain('studio closes');
    const record = await lastRecord();
    expect(record.status).toBe('injected');
    expect(record.degraded).toBeUndefined();
    // Qualified on similarity: "website" alone is half the message's distinctive words.
    expect(record.items.map((i) => [i.title, i.qualifiedBy])).toEqual([['Pricing', ['similarity']]]);
    expect(record.items[0].score).toBeGreaterThanOrEqual(0.45);
    // Calibration's sample: the bar this run was decided at, cleared.
    expect(record.bar).toEqual({ minSimilarity: 0.45, cleared: true });
  });

  test('an identifier inside a long sentence is recalled through the keyword leg', async () => {
    await chunk('Invoices 2024', 'Invoice INV-2024-118 for Bakery Smit: three hours of logo design at 95 euro per hour, paid in May.');
    await chunk('Invoices 2024 (older)', 'Invoice INV-2024-117 for the garage: two hours of website maintenance, paid in April.');
    const { text } = await run('Could you check what exactly was billed on invoice INV-2024-118 last spring for the redesign project?');
    expect(text).toContain('INV-2024-118');
    expect(text).not.toContain('INV-2024-117');
    const record = await lastRecord();
    expect(record.items).toHaveLength(1);
    expect(record.items[0].qualifiedBy).toEqual(['identifier']);
    // Not on similarity: the vector leg alone would have missed it.
    expect(record.items[0].score).toBeLessThan(0.45);
  });

  test('a year in the question is not an identifier: a passage holding it does not qualify on it', async () => {
    await chunk('Shopping list 2024', 'Shopping list 2024: eggs, milk, bread, coffee beans and dish soap.');
    const { text } = await run('What did we decide in the 2024 planning meeting about hiring?');
    expect(text).not.toContain('Shopping list');
    expect(await lastRecord()).toMatchObject({ status: 'abstained', reason: 'nothing_relevant' });
  });

  test('a short message of common words that matches every keyword of an unrelated passage is not injected', async () => {
    // The old rule kept any keyword match whatever its similarity: "try" and "one" are both in this passage.
    await chunk('Logo feedback', 'Try one of the three logo drafts first; the client liked the blue one best, and the bakery wants the final files by Friday.');
    const { text } = await run('try one?');
    expect(text).not.toContain('<recalled-knowledge>');
    expect(await lastRecord()).toMatchObject({ status: 'abstained', reason: 'nothing_relevant' });
  });

  test('a follow-up finds its subject through the previous message', async () => {
    await chunk('Enterprise plans', 'Enterprise website plans start at 9000 euro a year, with priority support and a named contact.');
    const alone = await run('and for enterprise?');
    expect(alone.text).not.toContain('Enterprise plans');
    const followUp = await run('and for enterprise?', { previousMessage: 'What do we charge for a website?' });
    expect(followUp.text).toContain('Note "Enterprise plans"');
    expect((await lastRecord()).items[0].qualifiedBy).toContain('coverage');
  });

  test('a short self-contained question after another topic is searched on its own first', async () => {
    await chunk('Refunds', 'Refund policy: we refund the deposit within 14 days when a project is cancelled before work starts.');
    await chunk('Invoice 118', 'Invoice INV-2024-118 for Bakery Smit: logo design, sent in May, still unpaid; send a friendly email reminder.');
    const previousMessage = 'Please draft a friendly email to the bakery about the overdue invoice INV-2024-118 from May';
    const alone = await run('What is our refund policy?');
    expect(alone.text).toContain('Note "Refunds"');
    const after = await run('What is our refund policy?', { previousMessage });
    expect(after.text).toContain('Note "Refunds"');
    // The previous message's own passage holds no word of this one: it is not brought in.
    expect(after.text).not.toContain('Invoice 118');
    expect((await lastRecord()).items.map((i) => i.title)).toEqual(['Refunds']);
  });

  test('the follow-up search runs only when the message alone left slots free', async () => {
    const { createContextHook, updateContextHook } = await import('@/core/context-hooks');
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    await updateContextHook(userId, 'builtin:knowledge-recall', { enabled: false });
    await createContextHook(userId, { name: 'One passage', kind: 'recall', config: { limit: 1 } });
    await chunk('Enterprise plans', 'Enterprise plans start at 9000 euro a year, with priority support and a named contact.');
    const embedCalls = () => vi.mocked(getEmbeddingService().generateEmbedding).mock.calls.length;
    const before = embedCalls();
    const filled = await run('enterprise plans?', { previousMessage: 'What do we charge for a website?' });
    expect(filled.text).toContain('Note "Enterprise plans"');
    expect(embedCalls() - before).toBe(1);
    // Nothing found alone: the second search, of both messages together, runs.
    const mid = embedCalls();
    await run('and the website?', { previousMessage: 'How much are the enterprise plans?' });
    expect(embedCalls() - mid).toBe(2);
  });

  test('a one-word follow-up is searched with the previous message; an acknowledgement after a question is not', async () => {
    await chunk('Enterprise plans', 'Enterprise website plans start at 9000 euro a year, with priority support and a named contact.');
    const previousMessage = 'What do we charge for a website?';
    expect((await run('Enterprise?')).text).not.toContain('Enterprise plans');
    expect(await lastRecord()).toMatchObject({ status: 'skipped', reason: 'short_message' });
    const followUp = await run('Enterprise?', { previousMessage });
    expect(followUp.text).toContain('Note "Enterprise plans"');
    for (const ack of ['thanks', 'yes please']) {
      expect((await run(ack, { previousMessage })).text).not.toContain('<recalled-knowledge>');
      expect(await lastRecord()).toMatchObject({ status: 'skipped', reason: 'short_message' });
    }
  });

  test('the default four passages fit the default budget, with their excerpts', async () => {
    const long = (topic: string) => `${topic} website pricing notes. ${'The quoted price covers design, build, testing and one round of changes for the client. '.repeat(10)}`;
    for (const t of ['Studio', 'Agency', 'Freelance', 'Retainer']) await chunk(`${t} pricing`, long(t));
    const { text } = await run('website pricing');
    const record = await lastRecord();
    expect(record.items).toHaveLength(4);
    expect(text.match(/^Note "/gm)).toHaveLength(4);
  });
});

describe('what the search window holds', () => {
  test('a hook limited to notes finds the one note among many matching documents', async () => {
    const { createContextHook, updateContextHook } = await import('@/core/context-hooks');
    await updateContextHook(userId, 'builtin:knowledge-recall', { enabled: false });
    await createContextHook(userId, { name: 'Notes only', kind: 'recall', config: { purposes: ['note'] } });
    for (let i = 0; i < 30; i++) {
      await chunk(`Quote ${i}`, `Website pricing quote ${i}: a website costs 2400 euro for the design and build.`, { source: `doc:${randomUUID()}`, purpose: 'document' });
    }
    await chunk('Our rates', 'Our website pricing: we charge a fixed rate per page, agreed before the work starts.');
    const { text } = await run('website pricing');
    expect(text).toContain('Note "Our rates"');
    expect(text).not.toContain('Document "');
    expect(await lastRecord()).toMatchObject({ status: 'injected' });
  });

  test('one large document\'s chunks do not crowd out the other sources', async () => {
    const source = `doc:${randomUUID()}`;
    for (let i = 0; i < 40; i++) {
      await chunk('Price book', `Website pricing, section ${i}: a website costs 2400 euro for design and build.`, { source, purpose: 'document' });
    }
    await chunk('Our rates', 'Our website pricing: we charge a fixed rate per page, agreed before the work starts.');
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    const search = await getEmbeddingService().hybridSearchAnyTerm({ kind: 'personal', userId, workspaceId: null }, 'website pricing', 20, { perSource: 3 });
    expect(search.candidates.filter((c) => c.sourceId === source)).toHaveLength(3);
    expect(search.candidates.map((c) => c.metadata.title)).toContain('Our rates');
    const { text } = await run('website pricing');
    expect(text).toContain('Note "Our rates"');
    expect(text.match(/Document "Price book"/g)).toHaveLength(1);
  });

  test('the product manual stays out of the window unless the hook includes it', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    for (let i = 0; i < 25; i++) {
      await queryRaw(
        `INSERT INTO embeddings (id, source_id, content, model, embedding, purpose, content_sha256, embedding_version, user_id, metadata)
         VALUES ($1, $2, $3, 'fake', $4, 'document', $5, 'fake/512', NULL, $6)`,
        [randomUUID(), `docs:${i}`, `Website pricing in the manual, part ${i}.`, vectorLiteral(embed(`Website pricing in the manual, part ${i}.`)), randomUUID(), JSON.stringify({ title: `Manual ${i}`, source: 'octipus-docs' })],
      );
    }
    await chunk('Our rates', 'Our website pricing: we charge a fixed rate per page, agreed before the work starts.');
    const scope = { kind: 'personal' as const, userId, workspaceId: null };
    const without = await getEmbeddingService().hybridSearchAnyTerm(scope, 'website pricing', 5, { excludeProductDocs: true });
    expect(without.candidates.map((c) => c.metadata.title)).toEqual(['Our rates']);
    const withDocs = await getEmbeddingService().hybridSearchAnyTerm(scope, 'website pricing', 5);
    expect(withDocs.candidates.some((c) => c.metadata.source === 'octipus-docs')).toBe(true);
  });
});

describe('lesson notes', () => {
  const LESSON = 'Website pricing is quoted per page: a fixed price per page was chosen over hourly billing.';

  test('the default hook recalls a lesson and labels it as one', async () => {
    await chunk('Quote websites per page', LESSON, { purpose: 'lesson' });
    const { text } = await run('How is website pricing quoted?');
    expect(text).toContain('Lesson "Quote websites per page"');
    expect(text).not.toContain('Note "Quote websites per page"');
    expect((await lastRecord()).items.map((i) => i.title)).toEqual(['Quote websites per page']);
  });

  test('a hook whose stored purposes predate lessons does not recall one; the user\'s note it still does', async () => {
    const { updateContextHook } = await import('@/core/context-hooks');
    await updateContextHook(userId, 'builtin:knowledge-recall', { config: { purposes: ['note', 'document', 'knowledge_artifact', 'image_description'] } });
    await chunk('Quote websites per page', LESSON, { purpose: 'lesson' });
    expect((await run('How is website pricing quoted?')).text).toBe('');
    await chunk('Our rates', 'Our website pricing: we charge a fixed rate per page, agreed before the work starts.');
    const { text } = await run('How is website pricing quoted?');
    expect(text).toContain('Note "Our rates"');
    expect(text).not.toContain('Lesson "');
  });
});

describe('the keyword leg is bounded', () => {
  test('a long paste searches at most MAX_KEYWORD_LEXEMES lexemes; coverage still counts every one', async () => {
    const { getEmbeddingService, MAX_KEYWORD_LEXEMES } = await import('@/core/rag/embeddings');
    const words = Array.from({ length: 250 }, (_, i) => `term${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}word`);
    const paste = `${words.join(' ')} INV-2024-118`;
    await chunk('Invoice', 'Invoice INV-2024-118 for the bakery, paid in May.');
    const search = await getEmbeddingService().hybridSearchAnyTerm({ kind: 'personal', userId, workspaceId: null }, paste, 5);
    expect(search.queryLexemes.length).toBeGreaterThan(250);
    expect(search.keywordLexemes).toHaveLength(MAX_KEYWORD_LEXEMES);
    // The reference's lexemes are searched first: the passage holding it is still a keyword candidate.
    expect(search.keywordLexemes).toEqual(expect.arrayContaining(['-2024', '-118']));
    const hit = search.candidates.find((c) => c.metadata.title === 'Invoice');
    // Matched against every lexeme of the paste: `inv` was not searched for (too short to make the cut) and still counts.
    expect(search.keywordLexemes).not.toContain('inv');
    expect(hit?.matchedLexemes.sort()).toEqual(['-118', '-2024', 'inv']);
  });
});

describe('whether the answer used what was shown', () => {
  const finish = async (turn: Awaited<ReturnType<typeof run>>['turn'], response?: string) => {
    const { finishContextTurn } = await import('@/core/context-hooks');
    await finishContextTurn(turn, { ...(response !== undefined ? { response } : {}), outcome: 'success' });
    const { rows } = await queryRaw('SELECT * FROM context_turns ORDER BY created_at DESC LIMIT 1');
    return rows[0];
  };

  test('finishing a turn records the passages the answer used, and the row holds no message, passage or answer text', async () => {
    await chunk('Pricing', 'Pricing: a website costs 2400 euro, hosting 15 euro a month, renovations quoted per project.');
    await chunk('Website hosting', 'Website hosting: every website runs on our own servers with backups and updates included.');
    const first = await run('What do we charge for a website?');
    expect(first.text).toContain('2400 euro');
    const used = await finish(first.turn, 'A website is 2400 euro; the answer is in the Pricing note.');
    expect(used).toMatchObject({ used_items: 1, cited_items: 1 });
    const stored = JSON.stringify(used);
    for (const text of ['2400', 'What do we charge', 'renovations', 'backups and updates', 'the answer is in']) expect(stored).not.toContain(text);

    // An answer that repeats nothing of the passages used none of them.
    expect(await finish((await run('What do we charge for a website?')).turn, 'I am not sure, let me look.')).toMatchObject({ used_items: 0 });
    // Nothing shown, nothing to measure: null, not zero.
    expect(await finish((await run('quarterly tax deadline')).turn, 'The deadline is 2026-01-31.')).toMatchObject({ used_items: null });
  });
});

describe('when the query cannot be embedded', () => {
  test('recall runs on its keyword rules alone, says so in the run record, and logs it', async () => {
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    vi.mocked(getEmbeddingService().generateEmbedding).mockRejectedValue(new Error('provider down'));
    const { coreLogger } = await import('@/utils/logger');
    const warn = vi.spyOn(coreLogger, 'warn');
    await chunk('Pricing', 'Website pricing: a five page website costs 900 euro, hosting 15 euro a month.');
    await chunk('Logo feedback', 'Try one of the three logo drafts first; the client liked the blue one best.');
    const covered = await run('website pricing');
    expect(covered.text).toContain('Note "Pricing"');
    expect(await lastRecord()).toMatchObject({ status: 'injected', degraded: 'embedding_failed' });
    expect((await lastRecord()).items[0].qualifiedBy).toEqual(['coverage']);
    // No similarity to fall back on: one shared word is still not enough.
    await run('try one?');
    expect(await lastRecord()).toMatchObject({ status: 'abstained', degraded: 'embedding_failed' });
    expect(warn.mock.calls.some(([, msg]) => typeof msg === 'string' && /recall: the query could not be embedded/.test(msg))).toBe(true);
  });
});

describe('side effects only for what is shown', () => {
  test('an injected passage raises the session\'s level and counts an access', async () => {
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    const id = await chunk('Contract', 'Contract terms: the website build costs 2400 euro, payable in two parts.', { source: `doc:${randomUUID()}`, purpose: 'document' });
    const other = await chunk('Holidays', 'The studio closes from 24 December to 2 January.');
    expect(sessionProtectionLevel('sess-shown')).toBe(1);
    const { text } = await run('what does the website build cost', { sessionId: 'sess-shown' });
    expect(text).toContain('Document "Contract"');
    // Raised before runContextHooks returned: a document gone since it was indexed counts as unclear.
    expect(sessionProtectionLevel('sess-shown')).toBe(4);
    expect(await accessCounts()).toEqual({ [id]: 1, [other]: 0 });
  });

  test('a start that can still be refused counts the access only once its agent exists; the level is raised at once', async () => {
    const { runContextHooks, bindTurnToAgent } = await import('@/core/context-hooks');
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    const id = await chunk('Contract', 'Contract terms: the website build costs 2400 euro, payable in two parts.', { source: `doc:${randomUUID()}`, purpose: 'document' });
    const out = await runContextHooks({ event: 'worker_start', userId, workspaceId: null, sessionId: 'sess-onstart', query: 'what does the website build cost', accessOnStart: true });
    expect(out.text).toContain('Document "Contract"');
    // Raised before the model is chosen; not counted while the spawn may still refuse.
    expect(sessionProtectionLevel('sess-onstart')).toBe(4);
    expect((await accessCounts())[id]).toBe(0);
    bindTurnToAgent(out.turn, 'agent-started');
    expect((await accessCounts())[id]).toBe(1);
    // A retry binds again: counted once.
    bindTurnToAgent(out.turn, 'agent-retry');
    expect((await accessCounts())[id]).toBe(1);
  });

  test('a block dropped for the shared budget raises no level and counts no access', async () => {
    const { createContextHook, updateContextHook } = await import('@/core/context-hooks');
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    const { getConfig } = await import('@/config');
    // A context note first, then a recall hook: the note spends the budget.
    await updateContextHook(userId, 'builtin:knowledge-recall', { enabled: false });
    await queryRaw(`INSERT INTO notes (id, user_id, slug, title, body, body_sha256) VALUES ($1, $2, 'about-me', 'About me', $3, $4)`,
      [randomUUID(), userId, 'I run a design studio. '.repeat(200), randomUUID()]);
    await createContextHook(userId, { name: 'About me', kind: 'note', config: { slug: 'about-me', tokenBudget: 600 } });
    await createContextHook(userId, { name: 'Recall', kind: 'recall' });
    const id = await chunk('Contract', 'Contract terms: the website build costs 2400 euro, payable in two parts, the first on signing.', { source: `doc:${randomUUID()}`, purpose: 'document' });

    const settings = getConfig().contextHooks;
    const before = settings.maxTokens;
    settings.maxTokens = 680;
    try {
      const { text } = await run('what does the website build cost', { sessionId: 'sess-budget' });
      expect(text).toContain('<context-note');
      expect(text).not.toContain('<recalled-knowledge>');
    } finally {
      settings.maxTokens = before;
    }
    const { rows } = await queryRaw('SELECT hooks FROM context_turns');
    const hooks = rows[0].hooks as ContextHookRunRecord[];
    expect(hooks.map((h) => [h.hook, h.status, h.reason ?? null])).toEqual([['About me', 'injected', null], ['Recall', 'skipped', 'budget_spent']]);
    // Left out after it searched: the record keeps how its search went.
    expect(hooks[1].bar).toEqual({ minSimilarity: 0.45, cleared: expect.any(Boolean) });
    expect(sessionProtectionLevel('sess-budget')).toBe(1);
    expect((await accessCounts())[id]).toBe(0);
  });

  test('a hook that times out raises no level and counts no access, even when it finishes later', async () => {
    const { sessionProtectionLevel } = await import('@/core/protection/session-level');
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(getEmbeddingService().generateEmbedding).mockImplementation(async (text: string) => {
      await gate;
      return embed(text);
    });
    // The hook's own work, which runContextHooks stops waiting for at the deadline.
    const kinds = await import('./kinds');
    const runRecall = kinds.KIND_RUNNERS.recall;
    let late: Promise<unknown> | undefined;
    vi.spyOn(kinds.KIND_RUNNERS, 'recall').mockImplementation((input, config) => {
      const work = runRecall(input, config);
      late = work;
      return work;
    });
    const id = await chunk('Contract', 'Contract terms: the website build costs 2400 euro, payable in two parts.', { source: `doc:${randomUUID()}`, purpose: 'document' });
    const { text } = await run('what does the website build cost', { sessionId: 'sess-late' });
    expect(text).not.toContain('<recalled-knowledge>');
    expect(await lastRecord()).toMatchObject({ status: 'error', reason: 'timeout' });
    // The search finishes after the deadline: it must leave nothing behind.
    // Waited for to its end, so the checks below see whatever it did.
    expect(late).toBeDefined();
    release();
    // It ends at the deadline's abort (recall starts no search after it), and only then is checked.
    await expect(late).rejects.toThrow('timeout');
    await accessSettled();
    expect(sessionProtectionLevel('sess-late')).toBe(1);
    expect((await accessCounts())[id]).toBe(0);
  }, 15_000);

  test('a block dropped when its commit fails gives its tokens back to a later block', async () => {
    const contentRead = await import('@/core/protection/content-read');
    vi.spyOn(contentRead, 'readKnowledge').mockRejectedValue(new Error('level store down'));
    const { createContextHook, updateContextHook } = await import('@/core/context-hooks');
    const { getConfig } = await import('@/config');
    // Recall first, a context note after it: together they exceed the budget, the note alone fits.
    await updateContextHook(userId, 'builtin:knowledge-recall', { enabled: false });
    await createContextHook(userId, { name: 'Recall', kind: 'recall' });
    await queryRaw(`INSERT INTO notes (id, user_id, slug, title, body, body_sha256) VALUES ($1, $2, 'about-me', 'About me', $3, $4)`,
      [randomUUID(), userId, 'I run a design studio. '.repeat(60), randomUUID()]);
    await createContextHook(userId, { name: 'About me', kind: 'note', config: { slug: 'about-me', tokenBudget: 400 } });
    await chunk('Pricing', 'Pricing: a website costs 2400 euro.');
    const settings = getConfig().contextHooks;
    const before = settings.maxTokens;
    settings.maxTokens = 450;
    try {
      const { text } = await run('What do we charge for a website?', { sessionId: 'sess-giveback' });
      expect(text).not.toContain('<recalled-knowledge>');
      expect(text).toContain('<context-note');
    } finally {
      settings.maxTokens = before;
    }
    const { rows } = await queryRaw('SELECT hooks FROM context_turns ORDER BY created_at DESC LIMIT 1');
    const hooks = rows[0].hooks as ContextHookRunRecord[];
    expect(hooks.map((h) => [h.hook, h.status, h.reason ?? null])).toEqual([['Recall', 'error', 'commit_failed'], ['About me', 'injected', null]]);
  });

  test('hooks and their commits share one deadline: a slow hook leaves its commit only the rest of it', async () => {
    const { START_DEADLINE_MS } = await import('@/core/context-hooks/run');
    const { getEmbeddingService } = await import('@/core/rag/embeddings');
    vi.mocked(getEmbeddingService().generateEmbedding).mockImplementation(async (text: string) => {
      await new Promise((r) => setTimeout(r, 3_000));
      return embed(text);
    });
    const contentRead = await import('@/core/protection/content-read');
    vi.spyOn(contentRead, 'readKnowledge').mockImplementation(() => new Promise<never>(() => {}));
    await chunk('Pricing', 'Pricing: a website costs 2400 euro, design and build included.');
    const started = Date.now();
    const { text } = await run('What do we charge for a website?', { sessionId: 'sess-deadline' });
    const took = Date.now() - started;
    expect(text).not.toContain('<recalled-knowledge>');
    expect(await lastRecord()).toMatchObject({ status: 'error', reason: 'commit_failed' });
    expect(took).toBeLessThan(START_DEADLINE_MS + 2000);
  }, 15_000);

  test('a commit that fails leaves its block out and is logged', async () => {
    const contentRead = await import('@/core/protection/content-read');
    vi.spyOn(contentRead, 'readKnowledge').mockRejectedValue(new Error('level store down'));
    const { coreLogger } = await import('@/utils/logger');
    const error = vi.spyOn(coreLogger, 'error');
    await chunk('Pricing', 'Pricing: a website costs 2400 euro.');
    const { text, repeatable } = await run('What do we charge for a website?');
    expect(text).not.toContain('<recalled-knowledge>');
    expect(repeatable).toEqual([]);
    expect(await lastRecord()).toMatchObject({ status: 'error', reason: 'commit_failed', tokens: 0, items: [], bar: { minSimilarity: 0.45, cleared: true } });
    expect(error.mock.calls.some(([, msg]) => typeof msg === 'string' && /committing its block failed/.test(msg))).toBe(true);
  });
});

describe('a passage still in view is not sent again', () => {
  const pricing = 'Pricing: a website costs 2400 euro. That covers design, build and one round of changes; hosting is billed apart at 15 euro a month.';
  const hosting = 'Hosting: every website we build runs on our own servers; the price is 15 euro a month, backups and updates included.';
  const user = (content: string): AgentMessage => ({ role: 'user', content, timestamp: new Date() });

  test('turn two leaves out the passage turn one carries, sends the new one, and no empty fence on turn three', async () => {
    const { withoutRepeatedContext, restoreOmittedContext, REPEATED_CONTEXT_NOTE } = await import('@/core/agent/repeated-context');
    await chunk('Pricing', pricing);
    const first = await run('website pricing');
    expect(first.text).toContain('2400 euro');
    // No score and no position in what is sent: the bytes do not depend on the turn.
    expect(first.text).not.toMatch(/match \d|\[\d\]/);
    const history: AgentMessage[] = [user(`${first.text.trim()}\n\nwebsite pricing?`), { role: 'assistant', content: '2400 euro.', timestamp: new Date() }];

    await chunk('Hosting', hosting);
    const second = await run('website pricing');
    expect(second.text).toContain('2400 euro');
    expect(second.text).toContain('backups and updates');
    const sent = withoutRepeatedContext(second.text.trim(), second.repeatable, history);
    expect(sent.text).not.toContain('2400 euro');
    expect(sent.text).toContain('backups and updates');
    expect(sent.text.match(/<recalled-knowledge>/g)).toHaveLength(1);
    expect(sent.text.match(/<\/recalled-knowledge>/g)).toHaveLength(1);
    expect(sent.text).toContain(REPEATED_CONTEXT_NOTE);
    history.push(user(`${sent.text}\n\nand hosting?`), { role: 'assistant', content: '15 euro a month.', timestamp: new Date() });

    const third = await run('website pricing');
    const again = withoutRepeatedContext(third.text.trim(), third.repeatable, history);
    expect(again.text).not.toContain('recalled-knowledge');
    expect(again.text).toBe(REPEATED_CONTEXT_NOTE);
    expect(again.leftOut).toEqual([third.text.trim()]);

    // An in-turn compaction summarizes the earlier turns away: both passages come back, fenced.
    const message = user(`${again.text}\n\nanything else?`);
    const compacted: AgentMessage[] = [{ role: 'system', content: '[Context Summary] pricing was discussed', timestamp: new Date() }, message];
    expect(restoreOmittedContext(compacted, { content: message.content as string, omitted: again.omitted, fences: again.fences, noteAt: again.noteAt })).toBeUndefined();
    const restored = message.content as string;
    expect(restored).toContain('<recalled-knowledge>');
    expect(restored).toContain('2400 euro');
    expect(restored).toContain('backups and updates');
    expect(restored).not.toContain(REPEATED_CONTEXT_NOTE);
    expect(restored.indexOf('2400 euro')).toBeGreaterThan(restored.indexOf('<recalled-knowledge>'));
    expect(restored.indexOf('backups and updates')).toBeLessThan(restored.indexOf('</recalled-knowledge>'));
  });
});

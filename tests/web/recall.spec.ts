import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

const hooks = {
  enabled: true,
  maxTokens: 1200,
  hooks: [
    { id: 'builtin:knowledge-recall', builtin: 'knowledge-recall', name: 'Knowledge recall', kind: 'recall', events: ['turn_start', 'worker_start'], config: {}, enabled: true, description: 'Searches your knowledge base and notes with each message.' },
    { id: 'builtin:notes-index', builtin: 'notes-index', name: 'Notes index', kind: 'notes_index', events: ['turn_start'], config: {}, enabled: true, description: 'Tells the agent which notes you have.' },
  ],
};

const rate = (n: number, of: number) => ({ n, of });
const stats = {
  days: 30,
  turns: 4,
  byHook: [{ hook: 'Knowledge recall', kind: 'recall', runs: 4, injected: 2, abstained: 2, skipped: 0, errors: 0, avgTokens: 310, avgLatencyMs: 40, avgTopScore: 0.61 }],
  searched: rate(1, 4),
  searchedAfterInjection: rate(0, 2),
  searchedAfterAbstain: rate(1, 2),
  cited: rate(2, 2),
  byModel: [{ model: 'claude-cli', cli: true, turns: 4, injected: rate(2, 4), searched: rate(1, 4), cited: rate(2, 2) }],
  recent: [],
  memory: { facts: 0, missing: ['background_model'] },
};

test.describe('recall page', () => {
  test('shows the hooks, the numbers per model, and the memory warning; switches a hook off', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    const patches: unknown[] = [];
    await page.route('**/api/context-hooks', (route) => json(route, 200, hooks));
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, stats));
    await page.route('**/api/context-hooks/builtin*', async (route) => {
      patches.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await json(route, 200, { ...hooks.hooks[1], enabled: false });
    });

    await page.goto('/recall');
    await expect(page.getByText('Knowledge recall').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('claude-cli (CLI)')).toBeVisible();
    await expect(page.getByText(/bound to the background topic/)).toBeVisible();
    await expect(page.getByText('100%').first()).toBeVisible();

    const notesIndex = page.locator('li', { hasText: 'Notes index' });
    // The stub keeps answering "on", so the box ticks back; the request is what counts.
    await notesIndex.getByRole('checkbox', { name: 'on' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toMatchObject({ url: expect.stringContaining('/api/context-hooks/builtin%3Anotes-index'), body: { enabled: false } });
  });

  test('runs the eval and shows what was found', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/context-hooks', (route) => json(route, 200, hooks));
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, { ...stats, turns: 0, byHook: [], byModel: [], memory: { facts: 3, missing: [] } }));
    let sent: { cases: Array<{ question: string; expect: string[] }> } | null = null;
    await page.route('**/api/context-hooks/eval', async (route) => {
      sent = route.request().postDataJSON();
      await json(route, 200, {
        config: { limit: 4, minSimilarity: 0.45 },
        cases: [
          { question: 'What do we charge?', expect: ['Pricing'], hits: [{ title: 'Pricing', sourceId: 'note:1', score: 0.71 }], rank: 1, pass: true },
          { question: 'Capital of France?', expect: [], hits: [], rank: null, pass: true },
        ],
        found: rate(1, 1),
        mrr: 1,
        abstained: rate(1, 1),
      });
    });

    await page.goto('/recall');
    await expect(page.getByText(/Long-term memory is not being filled/)).toHaveCount(0);
    await page.locator('textarea').fill('What do we charge? => Pricing\nCapital of France? => -\nno arrow here');
    await page.getByRole('button', { name: /Run 2/ }).click();
    await expect(page.getByText('Pricing (0.71)')).toBeVisible();
    await expect(page.getByText('nothing injected')).toBeVisible();
    expect(sent).toEqual({ cases: [{ question: 'What do we charge?', expect: ['Pricing'] }, { question: 'Capital of France?', expect: [] }] });
  });
});

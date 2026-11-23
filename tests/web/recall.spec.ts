import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import type { ContextHookStats, ContextHooksResponse, RecallSweepResult } from '../../src/shared/context-hooks';

const hooks: ContextHooksResponse = {
  enabled: true,
  maxTokens: 2000,
  hooks: [
    { id: 'builtin:knowledge-recall', builtin: 'knowledge-recall', name: 'Knowledge recall', kind: 'recall', events: ['turn_start', 'worker_start'], config: { limit: 3 }, enabled: true, description: 'Searches your knowledge base and notes with each message.' },
    { id: 'builtin:notes-index', builtin: 'notes-index', name: 'Notes index', kind: 'notes_index', events: ['turn_start'], config: {}, enabled: true, description: 'Tells the agent which notes you have.' },
  ],
};

const rate = (n: number, of: number) => ({ n, of });
const use = (turns: number, unanswered = 0) => ({ turns, unanswered, injected: rate(2, turns), searched: rate(1, turns), cited: rate(1, 2), used: rate(2, 2) });
const stats: ContextHookStats = {
  days: 30,
  turns: 4,
  sampled: false,
  byHook: [{
    id: 'builtin:knowledge-recall', hook: 'Knowledge recall', kind: 'recall', runs: 4, injected: 2, abstained: 2, skipped: 0, errors: 0, avgTokens: 310, avgLatencyMs: 40, avgTopScore: 0.61,
    degraded: 1, budgetSpent: 0, commitFailed: 0, qualified: { similarity: 2, coverage: 1, identifier: 1 },
  }],
  searched: rate(1, 4),
  unanswered: 2,
  searchedAfterInjection: rate(0, 2),
  searchedAfterAbstain: rate(1, 2),
  cited: rate(1, 2),
  used: rate(2, 2),
  byModel: [{ model: 'claude-cli', cli: true, ...use(4) }],
  byEvent: [{ event: 'turn_start', ...use(3, 2) }, { event: 'worker_start', ...use(1) }],
  calibration: [],
  recent: [],
  memory: { facts: 0, missing: ['background_model'] },
};
const quiet: ContextHookStats = { ...stats, turns: 0, unanswered: 0, byHook: [], byModel: [], byEvent: [], memory: { facts: 3, missing: [] } };

test.describe('recall page', () => {
  test('shows the hooks with their defaults, the numbers per model and per event, and the memory warning; switches a hook off', async ({ authenticatedPage: page }) => {
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
    // Named beside used, the per-event rows, and why passages were shown.
    await expect(page.getByText('answers naming a recalled passage (1/2)')).toBeVisible();
    await expect(page.getByText('answers using a recalled passage (2/2)')).toBeVisible();
    await expect(page.getByText('agents started on a task (specialists, swarm children, spawned and hook agents)')).toBeVisible();
    // Starts that ended without an answer are counted apart, per event.
    await expect(page.getByText(/2 finished starts ended without an answer .* not in these rates/)).toBeVisible();
    await expect(page.locator('tr', { hasText: 'messages (root turns' }).locator('td').nth(2)).toHaveText('2');
    await expect(page.getByText('similarity 2 · coverage 1 · identifier 1')).toBeVisible();
    // Every recall setting is editable, blank ones showing their default.
    const recall = page.locator('li', { hasText: 'Knowledge recall' });
    await expect(recall.getByLabel('keywordCoverage')).toHaveAttribute('placeholder', '0.6 (default)');
    await expect(recall.getByLabel('maxGap')).toHaveAttribute('placeholder', '0.15 (default)');
    await expect(recall.getByLabel('excerptChars')).toHaveAttribute('placeholder', '1000 (default)');
    await expect(recall.getByLabel('tokenBudget')).toHaveAttribute('placeholder', '1200 (default)');
    // What it searches, every purpose by default, and the manual off.
    for (const name of ['notes', 'lessons', 'documents', 'saved knowledge', 'image descriptions']) await expect(recall.getByRole('checkbox', { name, exact: true })).toBeChecked();
    await expect(recall.getByRole('checkbox', { name: 'Octipus manual' })).not.toBeChecked();
    await expect(recall.getByLabel('limit')).toHaveValue('3');

    const notesIndex = page.locator('li', { hasText: 'Notes index' });
    // The stub keeps answering "on", so the box ticks back; the request is what counts.
    await notesIndex.getByRole('checkbox', { name: 'on', exact: true }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toMatchObject({ url: expect.stringContaining('/api/context-hooks/builtin%3Anotes-index'), body: { enabled: false } });
  });

  test('what recall searches is set with its checkboxes, the other settings kept, and the last purpose cannot be unticked', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    const patches: unknown[] = [];
    const onlyNotes: ContextHooksResponse = { ...hooks, hooks: [{ ...hooks.hooks[0], config: { limit: 3, purposes: ['note'] } }, hooks.hooks[1]] };
    let listed = hooks;
    await page.route('**/api/context-hooks', (route) => json(route, 200, listed));
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, quiet));
    await page.route('**/api/context-hooks/builtin*', async (route) => {
      patches.push(route.request().postDataJSON());
      await json(route, 200, hooks.hooks[0]);
    });
    await page.goto('/recall');
    const recall = page.locator('li', { hasText: 'Knowledge recall' });
    await recall.getByRole('checkbox', { name: 'documents', exact: true }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ config: { limit: 3, purposes: ['note', 'lesson', 'knowledge_artifact', 'image_description'] } });
    await recall.getByRole('checkbox', { name: 'Octipus manual' }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toEqual({ config: { limit: 3, includeProductDocs: true } });

    listed = onlyNotes;
    await page.reload();
    await expect(recall.getByRole('checkbox', { name: 'notes', exact: true })).toBeChecked();
    await expect(recall.getByRole('checkbox', { name: 'notes', exact: true })).toBeDisabled();
    await expect(recall.getByRole('checkbox', { name: 'documents', exact: true })).not.toBeChecked();
  });

  test('lessons are a purpose of their own: a list stored before them leaves them off until ticked', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    const patches: unknown[] = [];
    const stored: ContextHooksResponse = {
      ...hooks,
      hooks: [{ ...hooks.hooks[0], config: { limit: 3, purposes: ['note', 'document', 'knowledge_artifact', 'image_description'] } }, hooks.hooks[1]],
    };
    await page.route('**/api/context-hooks', (route) => json(route, 200, stored));
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, quiet));
    await page.route('**/api/context-hooks/builtin*', async (route) => {
      patches.push(route.request().postDataJSON());
      await json(route, 200, hooks.hooks[0]);
    });
    await page.goto('/recall');
    const recall = page.locator('li', { hasText: 'Knowledge recall' });
    const lessons = recall.getByRole('checkbox', { name: 'lessons', exact: true });
    await expect(lessons).not.toBeChecked();
    await expect(recall.getByTitle(/written by learning reviews/)).toHaveText('lessons');
    await lessons.click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ config: { limit: 3, purposes: ['note', 'lesson', 'document', 'knowledge_artifact', 'image_description'] } });
  });

  test('a recall hook that injects on nearly every message gets the calibration warning', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/context-hooks', (route) => json(route, 200, hooks));
    const message = 'Knowledge recall found a passage that cleared its minSimilarity on 98% of the 40 messages it searched. Run the threshold sweep below with your own questions and apply the value it recommends.';
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, {
      ...stats, calibration: [{ id: 'builtin:knowledge-recall', hook: 'Knowledge recall', verdict: 'injects_nearly_always', found: rate(39, 40), builtin: true, message }],
    }));
    await page.goto('/recall');
    await expect(page.getByRole('status').filter({ hasText: 'threshold sweep' })).toHaveText(message);
  });

  test('a context note is picked from the notes, by keyboard too', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    const created: unknown[] = [];
    await page.route('**/api/context-hooks', async (route) => {
      if (route.request().method() === 'POST') {
        created.push(route.request().postDataJSON());
        return json(route, 201, { id: 'h1' });
      }
      return json(route, 200, hooks);
    });
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, quiet));
    await page.route('**/api/notes/index', (route) => json(route, 200, { notes: [
      { id: 'n2', title: 'Pricing', slug: 'pricing', noteKind: 'note' },
      { id: 'n1', title: 'About me', slug: 'about-me', noteKind: 'note' },
    ] }));

    await page.goto('/recall');
    const picker = page.getByRole('combobox', { name: /^note/ });
    await expect(picker).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Add hook' })).toBeDisabled();
    // Sorted by title; chosen with the keyboard.
    await expect(picker.locator('option')).toHaveText(['Choose a note…', 'About me', 'Pricing']);
    await picker.focus();
    await page.keyboard.press('ArrowDown');
    await expect(picker).toHaveValue('about-me');
    await page.getByRole('button', { name: 'Add hook' }).click();
    await expect.poll(() => created.length).toBe(1);
    expect(created[0]).toEqual({ name: 'About me', kind: 'note', events: ['turn_start'], config: { slug: 'about-me' } });
  });

  test('with no notes yet, the picker says so and links to Notes', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/context-hooks', (route) => json(route, 200, hooks));
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, quiet));
    await page.route('**/api/notes/index', (route) => json(route, 200, { notes: [] }));
    await page.goto('/recall');
    await expect(page.getByText(/No notes yet/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('link', { name: 'Write one in Notes' })).toHaveAttribute('href', '/notes');
    await expect(page.getByRole('button', { name: 'Add hook' })).toBeDisabled();
  });

  test('runs the eval and shows what was found', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/context-hooks', (route) => json(route, 200, hooks));
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, quiet));
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

  test('sweeps the thresholds and applies the recommended one, keeping the hook\'s other settings', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/context-hooks', (route) => json(route, 200, hooks));
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, quiet));
    const sweep: RecallSweepResult = {
      config: { limit: 3, keywordCoverage: 0.6, maxGap: 0.15, minSimilarity: 0.45 },
      rows: [
        { minSimilarity: 0.3, found: rate(2, 2), abstained: rate(0, 1), mrr: 1 },
        { minSimilarity: 0.35, found: rate(2, 2), abstained: rate(1, 1), mrr: 1 },
        { minSimilarity: 0.45, found: rate(1, 2), abstained: rate(1, 1), mrr: 0.5 },
      ],
      recommended: 0.35,
      degraded: 0,
    };
    let swept: unknown = null;
    await page.route('**/api/context-hooks/eval/sweep', async (route) => {
      swept = route.request().postDataJSON();
      await json(route, 200, sweep);
    });
    const patches: unknown[] = [];
    await page.route('**/api/context-hooks/builtin*', async (route) => {
      patches.push(route.request().postDataJSON());
      await json(route, 200, hooks.hooks[0]);
    });

    await page.goto('/recall');
    await page.locator('textarea').fill('What do we charge? => Pricing\nWho is our accountant? => Contacts\nCapital of France? => -');
    await page.getByRole('button', { name: 'Sweep thresholds' }).click();
    const recommended = page.locator('tr', { hasText: 'recommended' });
    await expect(recommended).toContainText('0.35');
    await expect(page.locator('tr', { hasText: 'current' })).toContainText('0.45');
    expect(swept).toEqual({ cases: [
      { question: 'What do we charge?', expect: ['Pricing'] },
      { question: 'Who is our accountant?', expect: ['Contacts'] },
      { question: 'Capital of France?', expect: [] },
    ] });
    await page.getByRole('button', { name: 'Use 0.35 for Knowledge recall' }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toEqual({ config: { limit: 3, minSimilarity: 0.35 } });
    await expect(page.getByText('Saved: Knowledge recall now uses minSimilarity 0.35.')).toBeVisible();
  });

  test('a sweep without both kinds of question says why nothing is recommended', async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    await page.route('**/api/context-hooks', (route) => json(route, 200, hooks));
    await page.route('**/api/context-hooks/stats*', (route) => json(route, 200, quiet));
    await page.route('**/api/context-hooks/eval/sweep', (route) => json(route, 200, {
      config: { limit: 3, keywordCoverage: 0.6, maxGap: 0.15, minSimilarity: 0.45 },
      rows: [{ minSimilarity: 0.3, found: rate(1, 1), abstained: rate(0, 0), mrr: 1 }],
      recommended: null, reason: 'needs_both_kinds', degraded: 0,
    } satisfies RecallSweepResult));
    await page.goto('/recall');
    await page.locator('textarea').fill('What do we charge? => Pricing');
    await page.getByRole('button', { name: 'Sweep thresholds' }).click();
    await expect(page.getByText(/No value recommended: add both questions/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Use / })).toHaveCount(0);
  });
});

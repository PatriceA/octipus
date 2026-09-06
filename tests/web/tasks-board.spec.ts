import { test, expect } from './fixtures/auth';
import { stubAllDefaults, json } from './fixtures/api-stubs';

/**
 * The to-do list with structure: a phase with two sub-tasks, one of them
 * blocked by the other, one in progress; plus a done task. Both the list and
 * the board read the same flat rows and derive nesting and "waiting" locally.
 */
const created = '2026-09-01T00:00:00Z';
const tasks = [
  { id: 'phase', title: 'Phase 1: auth', status: 'open', priority: 0, category: 'Auth', estimate: 'L', parentId: null, blockedBy: [], source: 'agent', createdAt: created },
  { id: 'login', title: 'Login form', status: 'in_progress', priority: 2, category: 'Auth', estimate: 'S', parentId: 'phase', blockedBy: [], source: 'agent', createdAt: created },
  { id: 'cookie', title: 'Session cookie', status: 'open', priority: 0, category: 'Auth', estimate: 'M', parentId: 'phase', blockedBy: ['login'], source: 'agent', createdAt: created },
  { id: 'milk', title: 'Buy milk', status: 'open', priority: 0, category: null, parentId: null, blockedBy: [], source: 'user', createdAt: created },
  { id: 'old', title: 'Renew passport', status: 'done', priority: 0, category: null, parentId: null, blockedBy: [], source: 'user', createdAt: created, completedAt: created },
];
const ranked = [
  { ...tasks[1], bucket: 'doing', reason: 'in progress' },
  { ...tasks[3], bucket: 'backlog', reason: 'no date, no priority' },
  { ...tasks[2], bucket: 'waiting', reason: 'blocked by "Login form"' },
  { ...tasks[0], bucket: 'waiting', reason: '2 sub-tasks open' },
];

test.describe('tasks — structure, list and board', () => {
  const patches: { id: string; body: Record<string, unknown> }[] = [];

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    patches.length = 0;
    // The stub keeps state: the page re-fetches after every move, and a
    // server that forgot the move would snap the card straight back.
    const rows = tasks.map((t) => ({ ...t }));
    await page.route('**/api/tasks?view=next**', (route) => json(route, 200, { timezone: 'UTC', tasks: ranked }));
    await page.route('**/api/tasks', (route) => json(route, 200, { tasks: rows }));
    await page.route('**/api/tasks/*', (route) => {
      if (route.request().method() === 'PATCH') {
        const id = new URL(route.request().url()).pathname.split('/').pop()!;
        const body = route.request().postDataJSON();
        patches.push({ id, body });
        const row = rows.find((t) => t.id === id)!;
        Object.assign(row, body);
        return json(route, 200, row);
      }
      return json(route, 200, {});
    });
  });

  test('the list nests sub-tasks under their phase and says what is waiting on what', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    // "What next" grouping, straight from the ranked response: doing first, waiting last.
    await expect(page.locator('h2.section-label')).toHaveText(['In progress (1)', 'Backlog (1)', 'Waiting on other tasks (2)', 'Done (1)']);
    await expect(page.getByText('blocked by "Login form"').first()).toBeVisible();
    await expect(page.getByText('2 sub-tasks open').first()).toBeVisible();
    await expect(page.getByText('0/2 sub-tasks')).toBeVisible();

    // Grouped by category the phase and its children share one group, children indented.
    await page.getByRole('button', { name: 'category' }).click();
    const auth = page.locator('div.space-y-2', { has: page.locator('h2', { hasText: 'Auth (3)' }) });
    const rows = auth.getByTestId('task-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-depth', '0');
    await expect(rows.nth(0)).toContainText('Phase 1: auth');
    await expect(rows.nth(1)).toHaveAttribute('data-depth', '1');
    await expect(rows.nth(2)).toHaveAttribute('data-depth', '1');
    // The estimate rides along on the row.
    await expect(rows.nth(0)).toContainText('L');
  });

  test('the board has a column per status with category lanes, and moves cards between columns', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    await page.getByTestId('tasks-view-board').click();
    const board = page.getByTestId('task-board');
    await expect(board.getByTestId('board-column-open').locator('h2')).toHaveText('Open (3)');
    await expect(board.getByTestId('board-column-in_progress').locator('h2')).toHaveText('In progress (1)');
    await expect(board.getByTestId('board-column-done').locator('h2')).toHaveText('Done (1)');
    // Lanes inside the open column: Auth, then Uncategorized last.
    const lanes = board.getByTestId('board-column-open').getByTestId('board-lane');
    await expect(lanes).toHaveCount(2);
    await expect(lanes.nth(0)).toContainText('Auth');
    await expect(lanes.nth(1)).toContainText('Uncategorized');
    // A blocked card says so; a sub-task names its parent.
    const cookie = board.getByTestId('board-card').filter({ hasText: 'Session cookie' });
    await expect(cookie).toContainText('blocked by "Login form"');
    await expect(cookie).toContainText('Phase 1: auth');

    // Arrow buttons move a card: "Buy milk" → In progress, then drag it back via the DOM drag events.
    const milk = board.getByTestId('board-card').filter({ hasText: 'Buy milk' });
    await milk.getByRole('button', { name: 'Move to In progress' }).click();
    await expect.poll(() => patches).toEqual([{ id: 'milk', body: { status: 'in_progress' } }]);
    await expect(board.getByTestId('board-column-in_progress').getByTestId('board-card').filter({ hasText: 'Buy milk' })).toBeVisible();

    await board.getByTestId('board-column-in_progress').getByTestId('board-card').filter({ hasText: 'Buy milk' }).dragTo(board.getByTestId('board-column-done'));
    await expect.poll(() => patches.map((p) => p.body.status)).toEqual(['in_progress', 'done']);

    // The choice of view is remembered.
    await page.reload();
    await expect(page.getByTestId('task-board')).toBeVisible();
  });
});

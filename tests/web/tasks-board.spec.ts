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

/**
 * The work board on top of the list: assignees, checkout leases, the comment
 * thread and the role agents. One stateful stub answers every /api/tasks call
 * the way src/api/routes/tasks.ts does (release frees the claim, a comment
 * lands in the thread, a PATCH with a null assigneeKind clears the assignee).
 */
test.describe('tasks — work board (assignees, claims, comments, role agents)', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  let rows: Record<string, unknown>[];
  let calls: { method: string; path: string; body: any }[];
  let comments: Record<string, unknown>[];
  let roleAgents: { boardWritesAllowed: boolean; heartbeatEnabled: boolean; roles: Record<string, unknown>[] };
  /** The stub server's clock relative to the browser's. */
  let serverOffsetMs: number;
  /** While set, a PATCH waits for it before the stub applies it. */
  let patchGate: Promise<void> | null;
  /** While set, a plain list read waits for it (its body is taken before the wait). */
  let listGate: Promise<void> | null;
  const TTL_MS = 30 * 60_000;
  const withLease = (t: Record<string, unknown>) => ({
    ...t,
    leaseExpiresAt: t.checkedOutAt ? new Date(Date.parse(t.checkedOutAt as string) + TTL_MS).toISOString() : null,
  });

  test.beforeEach(async ({ authenticatedPage: page }) => {
    await stubAllDefaults(page);
    calls = [];
    serverOffsetMs = 0;
    patchGate = null;
    listGate = null;
    rows = [
      { id: 'spec', title: 'Write the spec', status: 'in_progress', priority: 0, category: null, parentId: null, blockedBy: [], source: 'agent', createdAt: created,
        assigneeKind: 'role', assigneeRef: 'pm', checkedOutBy: 'pm@sess-1', checkedOutAt: minutesAgo(5), checkoutRunId: 'run-1' },
      { id: 'tests', title: 'Write the tests', status: 'in_progress', priority: 0, category: null, parentId: null, blockedBy: [], source: 'agent', createdAt: created,
        assigneeKind: 'role', assigneeRef: 'qa', checkedOutBy: 'qa@sess-2', checkedOutAt: minutesAgo(90), checkoutRunId: 'run-2' },
      { id: 'deploy', title: 'Deploy it', status: 'open', priority: 0, category: null, parentId: null, blockedBy: [], source: 'user', createdAt: created,
        assigneeKind: 'node', assigneeRef: 'node-7', checkedOutBy: null, checkedOutAt: null, checkoutRunId: null },
      // A sub-task of "Deploy it", so the board's progress on the parent can be
      // checked with the child filtered out.
      { id: 'milk', title: 'Buy milk', status: 'open', priority: 0, category: null, parentId: 'deploy', blockedBy: [], source: 'user', createdAt: created,
        assigneeKind: null, assigneeRef: null, checkedOutBy: null, checkedOutAt: null, checkoutRunId: null },
    ];
    comments = [
      { id: 'c1', taskId: 'spec', authorKind: 'agent', authorRef: 'pm@sess-1', body: 'Drafted sections 1-3; hand-off to qa next.', createdAt: minutesAgo(4) },
      { id: 'c2', taskId: 'spec', authorKind: 'user', authorRef: 'u1', body: 'Keep it short.', createdAt: minutesAgo(2) },
    ];
    roleAgents = {
      boardWritesAllowed: false,
      heartbeatEnabled: true,
      roles: [
        { role: 'pm', activeTasks: 1, totalTasks: 1, enabled: false, hookId: null, known: true },
        { role: 'qa', activeTasks: 1, totalTasks: 1, enabled: false, hookId: null, known: true },
      ],
    };

    await page.route('**/api/roles', (route) => json(route, 200, { roles: [{ role: 'pm' }, { role: 'qa' }, { role: 'research' }] }));
    await page.route(/\/api\/tasks(\/|\?|$)/, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const path = url.pathname.replace(/^.*\/api\/tasks/, '') || '/';
      const method = req.method();
      const body = req.postData() ? req.postDataJSON() : undefined;
      calls.push({ method, path, body });

      if (path === '/role-agents') {
        if (method === 'PUT') {
          const r = roleAgents.roles.find((x) => x.role === body.role)!;
          r.enabled = body.enabled;
          return json(route, 200, { role: body.role, enabled: body.enabled });
        }
        return json(route, 200, roleAgents);
      }
      if (path === '/' && method === 'GET') {
        if (url.searchParams.get('view') === 'next') {
          const open = rows.filter((t) => t.status === 'open' || t.status === 'in_progress');
          return json(route, 200, { timezone: 'UTC', tasks: open.map((t) => ({ ...withLease(t), bucket: t.status === 'in_progress' ? 'doing' : 'backlog', reason: '' })) });
        }
        const body = { tasks: rows.map(withLease), serverNow: new Date(Date.now() + serverOffsetMs).toISOString() };
        if (listGate) await listGate;
        return json(route, 200, body);
      }
      if (path === '/' && method === 'POST') {
        const row = { id: `new-${rows.length}`, status: 'open', priority: 0, blockedBy: [], source: 'user', createdAt: created, checkedOutBy: null, checkedOutAt: null, ...body };
        rows.push(row);
        return json(route, 200, row);
      }
      const [, id, sub] = path.split('/');
      const row = rows.find((t) => t.id === id);
      if (!row) return json(route, 404, { error: 'Task not found' });
      if (sub === 'release' && method === 'POST') {
        Object.assign(row, { status: 'open', checkedOutBy: null, checkedOutAt: null, checkoutRunId: null });
        return json(route, 200, row);
      }
      if (sub === 'comments') {
        if (method === 'POST') {
          const c = { id: `c${comments.length + 1}`, taskId: id, authorKind: 'user', authorRef: 'u1', body: body.body, createdAt: new Date().toISOString() };
          comments.push(c);
          return json(route, 200, c);
        }
        return json(route, 200, { comments: comments.filter((c) => c.taskId === id), truncated: id === 'spec' });
      }
      if (method === 'PATCH') {
        if (patchGate) await patchGate;
        const patch = { ...body };
        if (patch.assigneeKind === null) patch.assigneeRef = null;
        Object.assign(row, patch);
        return json(route, 200, row);
      }
      return json(route, 200, row);
    });
  });

  test('rows and cards show the assignee; the toolbar filter narrows by assignee', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    const rowOf = (title: string) => page.getByTestId('task-row').filter({ hasText: title });
    await expect(rowOf('Write the spec').getByTestId('task-assignee')).toHaveText('pm role');
    await expect(rowOf('Write the spec').getByTestId('task-assignee')).toHaveAttribute('data-kind', 'role');
    await expect(rowOf('Deploy it').getByTestId('task-assignee')).toHaveText('node-7');
    await expect(rowOf('Deploy it').getByTestId('task-assignee')).toHaveAttribute('data-kind', 'node');
    await expect(rowOf('Buy milk').getByTestId('task-assignee')).toHaveCount(0);

    const filter = page.getByTestId('assignee-filter');
    await filter.selectOption('role:pm');
    await expect(page.getByTestId('task-row')).toHaveCount(1);
    await expect(page.getByTestId('task-row')).toContainText('Write the spec');
    await filter.selectOption('unassigned');
    await expect(page.getByTestId('task-row')).toHaveCount(1);
    await expect(page.getByTestId('task-row')).toContainText('Buy milk');
    await filter.selectOption('agents');
    await expect(page.getByTestId('task-row')).toHaveCount(3);
    await filter.selectOption('all');
    await expect(page.getByTestId('task-row')).toHaveCount(4);

    // The board carries the same chip and honours the same filter.
    await page.getByTestId('tasks-view-board').click();
    const card = page.getByTestId('board-card').filter({ hasText: 'Write the tests' });
    await expect(card.getByTestId('task-assignee')).toHaveText('qa role');
    await filter.selectOption('role:qa');
    await expect(page.getByTestId('board-card')).toHaveCount(1);
  });

  test('the inline editor sets, changes and clears the assignee; create can assign a role', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    const milk = page.getByTestId('task-row').filter({ hasText: 'Buy milk' });
    await milk.getByRole('button', { name: 'edit' }).click();
    await milk.getByLabel('Assignee kind').selectOption('role');
    await expect.poll(() => calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ assigneeKind: 'role', assigneeRef: 'pm' }]);
    await milk.getByLabel('Assignee role').selectOption('research');
    await expect(milk.getByTestId('task-assignee')).toHaveText('research role');
    await milk.getByLabel('Assignee kind').selectOption('');
    await expect.poll(() => calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
      { assigneeKind: 'role', assigneeRef: 'pm' },
      { assigneeKind: 'role', assigneeRef: 'research' },
      { assigneeKind: null, assigneeRef: null },
    ]);
    await expect(milk.getByTestId('task-assignee')).toHaveCount(0);

    // A person is free text, saved on Enter.
    await milk.getByLabel('Assignee kind').selectOption('user');
    await milk.getByLabel('Person').fill('sam');
    await milk.getByLabel('Person').press('Enter');
    await expect(milk.getByTestId('task-assignee')).toHaveText('sam');

    await page.getByPlaceholder('Add a task…').fill('Review the plan');
    await page.getByLabel('Assign to role').selectOption('qa');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await expect.poll(() => calls.find((c) => c.method === 'POST' && c.path === '/')?.body).toMatchObject({ title: 'Review the plan', assigneeKind: 'role', assigneeRef: 'qa' });
  });

  test('a live claim shows who is working it; a stale one says it lapsed; release frees it after a confirm', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    const spec = page.getByTestId('task-row').filter({ hasText: 'Write the spec' });
    await expect(spec.getByTestId('task-lease')).toHaveText('pm agent · working · 5m ago');
    await expect(spec.getByTestId('task-lease')).toHaveAttribute('data-live', 'true');
    const tests = page.getByTestId('task-row').filter({ hasText: 'Write the tests' });
    await expect(tests.getByTestId('task-lease')).toHaveText('claim lapsed');
    await expect(page.getByTestId('task-row').filter({ hasText: 'Buy milk' }).getByTestId('task-lease')).toHaveCount(0);

    // Dismissing the confirm sends nothing.
    page.once('dialog', (d) => d.dismiss());
    await spec.getByRole('button', { name: 'Release claim' }).click();
    expect(calls.some((c) => c.path.endsWith('/release'))).toBe(false);

    page.once('dialog', (d) => {
      expect(d.message()).toContain('pm agent');
      return d.accept();
    });
    await spec.getByRole('button', { name: 'Release claim' }).click();
    await expect.poll(() => calls.filter((c) => c.path.endsWith('/release'))).toEqual([{ method: 'POST', path: '/spec/release', body: { force: true } }]);
    await expect(spec.getByTestId('task-lease')).toHaveCount(0);
    await expect(spec.getByRole('button', { name: 'Release claim' })).toHaveCount(0);

    // The board card has the badge and the action too.
    await page.getByTestId('tasks-view-board').click();
    const card = page.getByTestId('board-card').filter({ hasText: 'Write the tests' });
    await expect(card.getByTestId('task-lease')).toHaveText('claim lapsed');
    page.once('dialog', (d) => d.accept());
    await card.getByRole('button', { name: 'Release claim' }).click();
    await expect.poll(() => calls.filter((c) => c.path.endsWith('/release')).map((c) => c.path)).toEqual(['/spec/release', '/tests/release']);
  });

  test('comments load when opened, say older ones are hidden, and post as you', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    const spec = page.getByTestId('task-row').filter({ hasText: 'Write the spec' });
    await expect(spec).toBeVisible();
    expect(calls.some((c) => c.path.endsWith('/comments'))).toBe(false);

    await spec.getByRole('button', { name: 'comments' }).click();
    const thread = spec.getByTestId('task-comments');
    await expect(thread.getByTestId('task-comment')).toHaveCount(2);
    await expect(thread).toContainText('older comments are hidden');
    const first = thread.getByTestId('task-comment').first();
    await expect(first).toHaveAttribute('data-author', 'agent');
    await expect(first).toContainText('pm agent');
    await expect(first).toContainText('4m ago');
    await expect(first).toContainText('Drafted sections 1-3');
    await expect(thread.getByTestId('task-comment').nth(1)).toContainText('you');

    await thread.getByLabel('Comment').fill('Looks good, ship it.');
    await thread.getByRole('button', { name: 'Post' }).click();
    await expect(thread.getByTestId('task-comment')).toHaveCount(3);
    await expect(thread.getByTestId('task-comment').last()).toContainText('Looks good, ship it.');
    expect(calls.find((c) => c.method === 'POST' && c.path === '/spec/comments')?.body).toEqual({ body: 'Looks good, ship it.' });
    await expect(thread.getByLabel('Comment')).toHaveValue('');

    // A task with no comments says so.
    const milk = page.getByTestId('task-row').filter({ hasText: 'Buy milk' });
    await milk.getByRole('button', { name: 'comments' }).click();
    await expect(milk.getByTestId('task-comments')).toContainText('no comments yet');
  });

  test('the role agents panel toggles a role agent and flags the missing board permission', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    const panel = page.getByTestId('role-agents');
    await expect(panel).toContainText('0 of 2 on');
    await expect(panel).toContainText('needs board permission');
    await panel.getByRole('button', { name: /Role agents/ }).click();
    const notice = panel.getByTestId('role-agents-permission');
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('link', { name: 'permissions' })).toHaveAttribute('href', '/permissions');
    await expect(notice.getByRole('link', { name: 'tools page' })).toHaveAttribute('href', '/tools');

    const pm = panel.getByRole('switch', { name: 'pm agent' });
    await expect(pm).toHaveAttribute('aria-checked', 'false');
    await pm.click();
    await expect(pm).toHaveAttribute('aria-checked', 'true');
    expect(calls.find((c) => c.method === 'PUT')).toEqual({ method: 'PUT', path: '/role-agents', body: { role: 'pm', enabled: true } });
    await expect(panel).toContainText('1 of 2 on');

    // With the permission in place the notice goes away.
    roleAgents.boardWritesAllowed = true;
    await pm.click();
    await expect(pm).toHaveAttribute('aria-checked', 'false');
    await expect(notice).toHaveCount(0);
  });

  test('the panel says it spans workspaces, and says so when the server heartbeat is off', async ({ authenticatedPage: page }) => {
    roleAgents.heartbeatEnabled = false;
    await page.goto('/tasks');
    const panel = page.getByTestId('role-agents');
    await expect(panel).toContainText('across all workspaces');
    await expect(panel).toContainText('heartbeat off on this server');
    await panel.getByRole('button', { name: /Role agents/ }).click();
    const off = panel.getByTestId('role-agents-heartbeat-off');
    await expect(off).toContainText("Heartbeat is disabled on this server; role agents won't run");
    await expect(off.getByRole('link', { name: 'settings page' })).toHaveAttribute('href', '/settings');
  });

  test('leases are judged on the server clock, not the browser clock', async ({ authenticatedPage: page }) => {
    // The server runs 3h behind the browser. Judged on the browser clock, a
    // claim taken 5 server-minutes ago would look long lapsed.
    serverOffsetMs = -3 * 60 * 60_000;
    const serverMinutesAgo = (m: number) => new Date(Date.now() + serverOffsetMs - m * 60_000).toISOString();
    rows[0].checkedOutAt = serverMinutesAgo(5);
    rows[1].checkedOutAt = serverMinutesAgo(45);
    await page.goto('/tasks');
    const spec = page.getByTestId('task-row').filter({ hasText: 'Write the spec' });
    await expect(spec.getByTestId('task-lease')).toHaveText('pm agent · working · 5m ago');
    await expect(page.getByTestId('task-row').filter({ hasText: 'Write the tests' }).getByTestId('task-lease')).toHaveText('claim lapsed');
  });

  test('the board counts sub-task progress over every task, not just the filtered ones', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    await page.getByTestId('tasks-view-board').click();
    await page.getByTestId('assignee-filter').selectOption('agents');
    // "Buy milk" (unassigned) is filtered out, but it is still Deploy's sub-task.
    await expect(page.getByTestId('board-card').filter({ hasText: 'Buy milk' })).toHaveCount(0);
    await expect(page.getByTestId('board-card').filter({ hasText: 'Deploy it' })).toContainText('0/1');
  });

  test('a role filter whose last task moves away stays visible, marked "(no tasks)"', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    const filter = page.getByTestId('assignee-filter');
    await filter.selectOption('role:qa');
    const row = page.getByTestId('task-row').filter({ hasText: 'Write the tests' });
    await row.getByRole('button', { name: 'edit' }).click();
    await row.getByLabel('Assignee role').selectOption('research');
    await expect(page.getByTestId('task-row')).toHaveCount(0);
    await expect(filter).toHaveValue('role:qa');
    await expect(filter.locator('option:checked')).toHaveText('qa role (no tasks)');
    await expect(page.getByText('no open tasks match this assignee filter')).toBeVisible();
    await filter.selectOption('all');
    await expect(filter.locator('option', { hasText: 'qa role' })).toHaveCount(0);
  });

  test('a poll that lands while an edit is in flight does not undo it', async ({ authenticatedPage: page }) => {
    await page.clock.install();
    await page.goto('/tasks');
    const milk = page.getByTestId('task-row').filter({ hasText: 'Buy milk' });
    await expect(milk).toBeVisible();

    let open!: () => void;
    patchGate = new Promise<void>((resolve) => { open = resolve; });
    await milk.getByRole('button', { name: 'Mark done' }).click();
    await expect(milk.getByRole('button', { name: 'Mark open' })).toBeVisible();
    // The 30s poll fires while the PATCH is held: the stub still says "open".
    const before = calls.filter((c) => c.method === 'GET' && c.path === '/').length;
    await page.clock.runFor(31_000);
    await expect.poll(() => calls.filter((c) => c.method === 'GET' && c.path === '/').length).toBeGreaterThan(before);
    await expect(milk.getByRole('button', { name: 'Mark open' })).toBeVisible();

    open();
    await expect.poll(() => rows.find((t) => t.id === 'milk')!.status).toBe('done');
    await expect(milk.getByRole('button', { name: 'Mark open' })).toBeVisible();
  });

  test('a notes save that overlaps an add\'s re-read still ends with the new task on the page', async ({ authenticatedPage: page }) => {
    await page.goto('/tasks');
    const milk = page.getByTestId('task-row').filter({ hasText: 'Buy milk' });
    await expect(milk).toBeVisible();

    // Hold the list read that follows the add.
    let release!: () => void;
    listGate = new Promise<void>((resolve) => { release = resolve; });
    const readsBefore = calls.filter((c) => c.method === 'GET' && c.path === '/').length;
    await page.getByPlaceholder('Add a task…').fill('Book the venue');
    await page.getByRole('button', { name: 'Add', exact: true }).first().click();
    await expect.poll(() => calls.filter((c) => c.method === 'GET' && c.path === '/').length).toBeGreaterThan(readsBefore);

    // Save notes while that read is out; the save itself does not re-read.
    await milk.getByRole('button', { name: 'add notes' }).click();
    await milk.getByPlaceholder('Add details, links, context…').fill('2 litres');
    await milk.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls.some((c) => c.method === 'PATCH' && c.body?.notes === '2 litres')).toBe(true);

    // The held read comes back stale (a write happened meanwhile) and is
    // dropped; the page reads again at once instead of waiting for the poll.
    listGate = null;
    release();
    await expect(page.getByTestId('task-row').filter({ hasText: 'Book the venue' })).toBeVisible({ timeout: 5_000 });
    await expect(milk).toContainText('2 litres');
  });

  test('the assignee editor follows outside changes, and focuses the name field for a person', async ({ authenticatedPage: page }) => {
    await page.clock.install();
    await page.goto('/tasks');
    const deploy = page.getByTestId('task-row').filter({ hasText: 'Deploy it' });
    await deploy.getByRole('button', { name: 'edit' }).click();
    await expect(deploy.getByLabel('Agent node')).toHaveValue('node-7');

    // An agent reassigns it; the next poll brings the change into the open editor.
    Object.assign(rows.find((t) => t.id === 'deploy')!, { assigneeKind: 'role', assigneeRef: 'qa' });
    await page.clock.runFor(31_000);
    await expect(deploy.getByLabel('Assignee kind')).toHaveValue('role');
    await expect(deploy.getByLabel('Assignee role')).toHaveValue('qa');

    await deploy.getByLabel('Assignee kind').selectOption('user');
    await expect(deploy.getByLabel('Person')).toBeFocused();
    // Mid-edit (nothing typed yet): a poll does not reset the editor.
    await page.clock.runFor(31_000);
    await expect(deploy.getByLabel('Assignee kind')).toHaveValue('user');
  });
});

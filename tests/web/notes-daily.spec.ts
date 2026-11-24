import { expect, type Page, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

/**
 * Notes as a daily tool: the open note in the address bar, search on the
 * server (bodies too), the archive with restore, and one pane at a time on a
 * phone. The API is stubbed in the browser; the stub answers `q` and
 * `archived=only` the way src/api/routes/notes.ts does.
 */

interface StubNote {
  id: string;
  title: string;
  slug: string;
  body: string;
  archivedAt: string | null;
}

function row(n: StubNote) {
  return { ...n, noteKind: 'note', tags: [], pinned: false, frontmatter: {}, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' };
}

async function stubNotes(page: Page, notes: StubNote[]) {
  const searches: string[] = [];
  const restored: string[] = [];
  await page.route('**/api/notes**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/\/$/, '');
    if (path.endsWith('/tags')) return json(route, 200, { tags: [] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    if (path.endsWith('/index')) return json(route, 200, { notes: notes.filter((n) => !n.archivedAt).map(row) });
    const restore = path.match(/\/api\/notes\/([^/]+)\/restore$/);
    if (restore && req.method() === 'POST') {
      restored.push(restore[1]);
      const n = notes.find((x) => x.id === restore[1]);
      if (n) n.archivedAt = null;
      return json(route, 200, { restored: true });
    }
    if (path === '/api/notes' && req.method() === 'GET') {
      const archived = url.searchParams.get('archived') === 'only';
      const q = url.searchParams.get('q');
      if (q) searches.push(q);
      const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const rows = notes
        .filter((n) => (archived ? n.archivedAt : !n.archivedAt))
        .filter((n) => words.every((w) => `${n.title} ${n.body}`.toLowerCase().includes(w)))
        .map(row);
      return json(route, 200, { notes: rows, total: rows.length });
    }
    const id = path.split('/').pop();
    const note = notes.find((n) => n.id === id);
    if (!note) return json(route, 404, { error: 'Note not found' });
    return json(route, 200, { ...row(note), bodySha256: 'x', backlinks: [], outgoing: [] });
  });
  return { searches, restored };
}

const NOTES: StubNote[] = [
  { id: 'n-1', title: 'Garden plan', slug: 'garden-plan', body: 'Plant tomatoes in May.', archivedAt: null },
  { id: 'n-2', title: 'Reading list', slug: 'reading-list', body: 'The overstory, then something about bees.', archivedAt: null },
  { id: 'n-3', title: 'Old recipe', slug: 'old-recipe', body: 'Lentil soup with cumin.', archivedAt: '2026-11-21T10:00:00Z' },
];

test('the open note is in the address bar: reload, back and forward follow it', async ({ authenticatedPage: page }) => {
  await stubNotes(page, structuredClone(NOTES));
  await page.goto('/notes?note=n-2');
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Reading list');
  await page.getByRole('button', { name: /Garden plan/ }).click();
  await expect(page).toHaveURL(/\/notes\?note=n-1$/);
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Garden plan');
  await page.goBack();
  await expect(page).toHaveURL(/\/notes\?note=n-2$/);
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Reading list');
  await page.goForward();
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Garden plan');
  await page.reload();
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Garden plan');
});

test('search asks the server and finds a word that is only in a note body', async ({ authenticatedPage: page }) => {
  const stub = await stubNotes(page, structuredClone(NOTES));
  await page.goto('/notes');
  await page.getByPlaceholder('Search notes').fill('bees');
  const hit = page.getByRole('button', { name: /Reading list/ });
  await expect(hit).toBeVisible();
  await expect(hit.getByTestId('note-snippet')).toContainText('bees');
  await expect(page.getByRole('button', { name: /Garden plan/ })).toHaveCount(0);
  expect(stub.searches).toContain('bees');
  // Archived notes are not search results.
  await page.getByPlaceholder('Search notes').fill('lentil');
  await expect(page.getByText('No matches')).toBeVisible();
});

test('the archive lists archived notes, opens one read-only, and restores it', async ({ authenticatedPage: page }) => {
  const notes = structuredClone(NOTES);
  const stub = await stubNotes(page, notes);
  await page.goto('/notes');
  await expect(page.getByRole('button', { name: /Old recipe/ })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('button', { name: /Garden plan/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Old recipe/ }).click();
  await expect(page.getByTestId('archived-note-banner')).toBeVisible();
  await expect(page.getByTestId('note-reader')).toContainText('Lentil soup');
  await page.getByRole('button', { name: 'Restore Old recipe' }).click();
  await expect.poll(() => stub.restored).toEqual(['n-3']);
  await expect(page.getByText('The archive is empty')).toBeVisible();
  await page.getByRole('tab', { name: 'All', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Old recipe/ })).toBeVisible();
});

test('on a phone the notes page shows one pane at a time, with the context panel closed', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubNotes(page, structuredClone(NOTES));
  await page.goto('/notes');
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  await expect(page.getByRole('button', { name: /Garden plan/ })).toBeVisible();
  await expect(page.getByPlaceholder('Untitled note')).toHaveCount(0);
  expect(await fits()).toBe(true);

  await page.getByRole('button', { name: /Garden plan/ }).click();
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Garden plan');
  await expect(page.getByRole('button', { name: /Reading list/ })).toHaveCount(0);
  await expect(page.getByTestId('note-context-sheet')).toHaveCount(0);
  expect(await fits()).toBe(true);
  // The editor is not covered by another pane.
  const box = await page.getByPlaceholder('Untitled note').boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);

  await page.getByTitle('Show context panel').click();
  await expect(page.getByTestId('note-context-sheet')).toBeVisible();
  await page.getByTestId('note-context-sheet').getByTitle('Hide context panel').click();
  await expect(page.getByTestId('note-context-sheet')).toHaveCount(0);

  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.getByRole('button', { name: /Reading list/ })).toBeVisible();
  await expect(page.getByPlaceholder('Untitled note')).toHaveCount(0);
});

test('a new note never overwrites one at the same slug: the save is refused and the draft stays', async ({ authenticatedPage: page }) => {
  const posts: Record<string, unknown>[] = [];
  await stubNotes(page, structuredClone(NOTES));
  await page.route('**/api/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const input = route.request().postDataJSON();
    posts.push(input);
    return json(route, 409, { error: 'A note already exists at old-recipe', code: 'exists', id: 'n-3', slug: 'old-recipe' });
  });
  await page.goto('/notes');
  await page.getByTitle('New note', { exact: true }).click();
  await page.locator('.cm-content').fill('Old recipe\nA different soup');
  await expect(page.getByTestId('note-save-status')).toContainText('already exists (perhaps in the archive): change the first line or the title');
  expect(posts[0]).toMatchObject({ title: 'Old recipe', createOnly: true });
  expect(posts[0].id).toBeUndefined();
  await expect(page.locator('.cm-content')).toContainText('A different soup');
});

test('a draft never follows a workspace switch: nothing is posted with the other workspace, and its copy stays in its own', async ({ authenticatedPage: page }) => {
  const SPACE = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000001';
  await page.route('**/api/spaces', (route) => json(route, 200, { spaces: [{ id: SPACE, name: 'Launch', slug: 'launch', role: 'editor', memberCount: 2, archivedAt: null, createdBy: 'o', createdAt: '2026-11-01T00:00:00Z', funding: 'own' }] }));
  await page.route(`**/api/spaces/${SPACE}`, (route) => json(route, 200, { id: SPACE, name: 'Launch', role: 'editor', archivedAt: null }));
  await stubNotes(page, []);
  const posts: { workspace: string | undefined; body: Record<string, unknown> }[] = [];
  await page.route('**/api/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    posts.push({ workspace: route.request().headers()['x-octipus-workspace'], body: route.request().postDataJSON() });
    return json(route, 500, { error: 'Storage unavailable' });
  });
  await page.goto('/notes');
  await page.getByTitle('New note', { exact: true }).click();
  await page.locator('.cm-content').fill('Private plan\nsalary negotiation notes');
  await expect(page.getByTestId('note-save-status')).toContainText('Not saved');
  expect(posts.every((p) => p.workspace === 'ws-1')).toBe(true);
  const tried = posts.length;

  await page.getByRole('button', { name: 'Switch workspace' }).click();
  await page.getByTestId('shared-spaces').getByText('Launch').click();
  await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText('Launch');
  await page.waitForTimeout(1500);
  expect(posts.filter((p) => p.workspace === SPACE)).toEqual([]);
  expect(posts.length).toBe(tried);
  // The copy is kept on this device under the workspace it was typed in.
  const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('octipus.note-draft.')));
  expect(kept.length).toBe(1);
  expect(kept[0]).toContain('.ws-1.new-');
});

test('a new note whose first save lands after the page was left does not pull the user back', async ({ authenticatedPage: page }) => {
  await stubNotes(page, []);
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await held;
    const input = route.request().postDataJSON();
    return json(route, 200, { note: { ...input, id: 'late', slug: 'late', bodySha256: 'a'.repeat(64), pinned: false, tags: [], noteKind: 'note', frontmatter: {}, archivedAt: null, updatedAt: '2026-11-20T00:00:00Z' }, created: true });
  });
  await page.goto('/notes');
  await page.getByTitle('New note', { exact: true }).click();
  await page.locator('.cm-content').fill('Late note\ntyped quickly');
  await expect(page.getByTestId('note-save-status')).toHaveText('Saving…');
  await page.getByRole('link', { name: 'To-dos', exact: true }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  release();
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(/\/tasks$/);
});

test('on a phone, Back from a new note saved on the way lands in the list', async ({ authenticatedPage: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const notes = structuredClone(NOTES);
  await stubNotes(page, notes);
  await page.route('**/api/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const input = route.request().postDataJSON();
    const note = { id: 'n-new', title: input.title, slug: 'shopping', body: input.body, archivedAt: null };
    notes.push(note);
    return json(route, 200, { note: { ...note, bodySha256: 'b'.repeat(64), tags: [], pinned: false, noteKind: 'note', frontmatter: {}, updatedAt: '2026-11-20T00:00:00Z' }, created: true });
  });
  await page.goto('/notes');
  await page.getByTitle('New note', { exact: true }).click();
  await page.keyboard.type('Shopping');
  // Straight to Back, the first line still being typed: Back saves it, then shows the list.
  await page.getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(/\/notes$/);
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Garden plan/ })).toBeVisible();
  expect(notes.find((n) => n.id === 'n-new')?.title).toBe('Shopping');
});

test('while a search is being typed the list filters locally, and clearing it shows every note at once', async ({ authenticatedPage: page }) => {
  await stubNotes(page, structuredClone(NOTES));
  await page.goto('/notes');
  await expect(page.getByRole('button', { name: /Reading list/ })).toBeVisible();
  await page.getByPlaceholder('Search notes').fill('bees');
  await expect(page.getByTestId('note-snippet')).toContainText('bees');
  await page.getByPlaceholder('Search notes').fill('');
  // No stale results in between: both notes are back straight away.
  await expect(page.getByRole('button', { name: /Garden plan/ })).toBeVisible({ timeout: 200 });
  await expect(page.getByRole('button', { name: /Reading list/ })).toBeVisible({ timeout: 200 });
  await expect(page.getByTestId('note-snippet')).toHaveCount(0);
});

test('signing out removes the note drafts kept in this browser', async ({ authenticatedPage: page }) => {
  await stubNotes(page, structuredClone(NOTES));
  await page.goto('/notes');
  await page.evaluate(() => {
    localStorage.setItem('octipus.note-draft.ws-1.n-1', JSON.stringify({ title: 't', body: 'secret', tags: [], noteKind: 'note', savedAt: 1 }));
    localStorage.setItem('octipus.note-draft.ws-1.new-abc', JSON.stringify({ title: 't', body: 'secret', tags: [], noteKind: 'note', savedAt: 1 }));
  });
  await page.getByRole('button', { name: /e2etest/ }).first().click();
  await page.getByRole('button', { name: 'sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('octipus.note-draft.')))).toEqual([]);
});

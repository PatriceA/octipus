import { expect, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

/** A stand-in for the server's body sha256: deterministic, 64 hex characters. */
function sha(text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

test('a note saves itself, keeps a failed draft, survives a reload at its own address, and archives with undo', async ({ authenticatedPage: page }) => {
  let notes: any[] = [];
  let failSave = false;
  const posts: any[] = [];
  await page.route('**/api/notes**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/api/notes' && req.method() === 'POST') {
      if (failSave) return json(route, 500, { error: 'Storage unavailable' });
      const input = req.postDataJSON();
      posts.push(input);
      const existing = notes.find(n => n.id === input.id);
      // As the server: an edit made from older text is refused.
      if (existing && input.ifSha256 && input.ifSha256 !== existing.bodySha256) return json(route, 409, { error: 'stale', code: 'stale', currentSha256: existing.bodySha256 });
      const { ifSha256: _base, createOnly: _create, ...fields } = input;
      const note = { ...existing, ...fields, id: 'crud-note', slug: 'cross-device-note', pinned: false, frontmatter: {}, noteKind: 'note', tags: input.tags || [], bodySha256: sha(input.body), archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes = [note];
      return json(route, 200, { note, created: !input.id, indexed: false, indexQueued: true });
    }
    if (path.endsWith('/restore')) { notes = notes.map(n => ({ ...n, archivedAt: null })); return json(route, 200, { restored: true }); }
    if (path.endsWith('/index')) return json(route, 200, { notes });
    if (path.endsWith('/tags')) return json(route, 200, { tags: [] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    if (req.method() === 'DELETE') { notes = notes.map(n => ({ ...n, archivedAt: new Date().toISOString() })); return json(route, 200, { deleted: true }); }
    if (path === '/api/notes') {
      const archived = url.searchParams.get('archived') === 'only';
      const rows = notes.filter(n => archived ? n.archivedAt : !n.archivedAt);
      return json(route, 200, { notes: rows, total: rows.length });
    }
    return json(route, 200, { ...notes[0], backlinks: [], outgoing: [] });
  });
  await page.goto('/notes');
  await page.getByTitle('New note', { exact: true }).click();
  await page.locator('.cm-content').fill('An idea captured on desktop');
  // No title yet: nothing can be saved, and the page says so.
  await expect(page.getByTestId('note-save-status')).toHaveText('Add a title to save');
  // A title being typed does not create the note (its slug would be fixed
  // from half a title): nothing goes out while the field has the focus.
  await page.getByPlaceholder('Untitled note').fill('Cross');
  await page.waitForTimeout(1500);
  expect(posts).toHaveLength(0);
  await page.getByPlaceholder('Untitled note').fill('Cross-device note');
  // Leaving the title field creates it; there is no Save button.
  await page.locator('.cm-content').click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect.poll(() => notes[0]?.body).toBe('An idea captured on desktop');
  await expect(page.getByTestId('note-save-status')).toHaveText('Saved');
  expect(posts.filter(p => !p.id)).toHaveLength(1);
  expect(posts[0]).toMatchObject({ title: 'Cross-device note', createOnly: true });
  // The open note is in the address bar.
  await expect(page).toHaveURL(/\/notes\?note=crud-note$/);

  // Edits name the text they were made from.
  await page.locator('.cm-content').fill('A second thought');
  await expect.poll(() => notes[0]?.body).toBe('A second thought');
  expect(posts.at(-1)).toMatchObject({ id: 'crud-note', ifSha256: sha('An idea captured on desktop') });
  expect(posts.at(-1).createOnly).toBeUndefined();

  failSave = true;
  await page.locator('.cm-content').fill('Keep this draft when saving fails');
  await expect(page.getByTestId('note-save-status')).toContainText('Not saved: Storage unavailable');
  await expect(page.locator('.cm-content')).toContainText('Keep this draft when saving fails');
  // A reload while the save is failing: the draft comes back from this device.
  await page.reload();
  await expect(page.getByTestId('draft-notice')).toContainText('Restored unsaved changes');
  await expect(page.getByText('Keep this draft when saving fails', { exact: false }).first()).toBeVisible();
  failSave = false;
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page.locator('.cm-content').press('End');
  await page.keyboard.type('!');
  await expect.poll(() => notes[0]?.body).toBe('Keep this draft when saving fails!');
  await expect(page.getByTestId('note-save-status')).toHaveText('Saved');
  expect(posts.every(p => !p.id || p.id === 'crud-note')).toBe(true);

  await page.reload();
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Cross-device note');
  await expect(page.getByTestId('draft-notice')).toHaveCount(0);

  // Changed elsewhere (another device) since this page read it: the save is
  // refused, the text stays here, and the user chooses.
  notes = [{ ...notes[0], body: 'Written on the phone', bodySha256: sha('Written on the phone') }];
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await page.locator('.cm-content').fill('Written on the desktop');
  await expect(page.getByTestId('draft-notice')).toContainText('changed elsewhere');
  expect(notes[0].body).toBe('Written on the phone');
  await expect(page.locator('.cm-content')).toContainText('Written on the desktop');
  await page.getByRole('button', { name: 'Keep my version' }).click();
  await expect.poll(() => notes[0]?.body).toBe('Written on the desktop');

  // Archive: gone from the list at once, with Undo.
  await page.getByTitle('Archive note', { exact: true }).click();
  await expect.poll(() => notes[0]?.archivedAt).toBeTruthy();
  await expect(page.getByTestId('undo-toast')).toContainText('Archived “Cross-device note”');
  await expect(page).toHaveURL(/\/notes$/);
  await page.getByTestId('undo-toast').getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => notes[0]?.archivedAt).toBeNull();
  await expect(page).toHaveURL(/\/notes\?note=crud-note$/);
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Cross-device note');
});

test('a cached copy older than the server is not loaded over newer text', async ({ authenticatedPage: page }) => {
  let note = { id: 'n-cache', title: 'Groceries', slug: 'groceries', body: 'milk', bodySha256: sha('milk'), noteKind: 'note', tags: [], pinned: false, frontmatter: {}, archivedAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  const other = { ...note, id: 'n-other', title: 'Other', slug: 'other', body: 'x', bodySha256: sha('x') };
  const posts: any[] = [];
  await page.route('**/api/notes**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/\/$/, '');
    if (req.method() === 'POST') { posts.push(req.postDataJSON()); return json(route, 500, { error: 'should not save' }); }
    if (path.endsWith('/tags')) return json(route, 200, { tags: [] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    if (path === '/api/notes' || path.endsWith('/index')) return json(route, 200, { notes: [note, other], total: 2 });
    return json(route, 200, { ...(path.endsWith('n-other') ? other : note), backlinks: [], outgoing: [] });
  });
  await page.goto('/notes?note=n-cache');
  await expect(page.getByText('milk').first()).toBeVisible();
  await page.getByRole('button', { name: /^Other/ }).click();
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Other');
  // Changed on another device while this page had the old copy cached.
  note = { ...note, body: 'milk, eggs and bread', bodySha256: sha('milk, eggs and bread'), updatedAt: '2026-11-02T00:00:00Z' };
  await page.goBack();
  await expect(page.getByText('milk, eggs and bread').first()).toBeVisible();
  await expect(page.getByTestId('note-save-status')).toHaveText('Saved');
  await page.waitForTimeout(1200);
  expect(posts).toEqual([]);
});

test('automated session learnings are collapsed below personal notes and remain searchable', async ({ authenticatedPage: page }) => {
  const row = (id: string, title: string, tags: string[], pinned = false) => ({
    id, title, slug: id, tags, pinned, body: 'Saved note', noteKind: 'note', frontmatter: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const notes = [row('personal', 'My project decisions', ['project']),
    row('pinned-learning', 'Pinned useful learning', ['session-learning'], true),
    ...Array.from({ length: 100 }, (_, i) => row(`learning-${i}`, `Automated finding ${i}`, ['session-learning']))];
  await page.route('**/api/notes**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
    if (path.endsWith('/tags')) return json(route, 200, { tags: [{ tag: 'session-learning', count: 101 }, { tag: 'project', count: 1 }] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    if (path === '/api/notes' || path.endsWith('/index')) return json(route, 200, { notes, total: notes.length });
    return json(route, 200, { ...notes[0], backlinks: [], outgoing: [] });
  });
  await page.goto('/notes');
  const group = page.getByRole('button', { name: 'Session learnings (100)', exact: true });
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: /My project decisions/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Pinned useful learning/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Automated finding 0/ })).toHaveCount(0);
  await group.click();
  await expect(page.getByRole('button', { name: /Automated finding 0/ })).toBeVisible();
  await group.click();
  await page.getByPlaceholder('search notes…').fill('Automated finding 99');
  await expect(page.getByRole('button', { name: /Automated finding 99/ })).toBeVisible();
  await page.getByPlaceholder('search notes…').clear();
  await page.getByRole('button', { name: 'session-learning 101', exact: true }).click();
  await expect(page.getByRole('button', { name: /Automated finding 0/ })).toBeVisible();
});

test('lesson notes are grouped by their kind or the tag, and a lesson seen more than once shows how often', async ({ authenticatedPage: page }) => {
  const row = (id: string, title: string, opts: { noteKind?: string; tags?: string[]; frontmatter?: Record<string, unknown> } = {}) => ({
    id, title, slug: id, tags: opts.tags ?? [], pinned: false, body: 'Saved note', noteKind: opts.noteKind ?? 'note', frontmatter: opts.frontmatter ?? {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const notes = [
    row('mine', 'My own sightings list', { frontmatter: { sightings: 4 } }),
    row('lesson-kind', 'Deploy only on weekdays', { noteKind: 'lesson', frontmatter: { sightings: 3 } }),
    row('lesson-tagged', 'Quote websites per page', { tags: ['session-learning'], frontmatter: { sightings: 1 } }),
  ];
  await page.route('**/api/notes**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/\/$/, '');
    if (path.endsWith('/tags')) return json(route, 200, { tags: [{ tag: 'session-learning', count: 1 }] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    if (path === '/api/notes' || path.endsWith('/index')) return json(route, 200, { notes, total: notes.length });
    return json(route, 200, { ...notes[0], backlinks: [], outgoing: [] });
  });
  await page.goto('/notes');
  const group = page.getByRole('button', { name: 'Session learnings (2)', exact: true });
  await expect(group).toBeVisible();
  // The user's own note stays in the list, with no count even if its properties hold one.
  await expect(page.getByRole('button', { name: /^My own sightings list/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /My own sightings list ×/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Deploy only on weekdays/ })).toHaveCount(0);
  await group.click();
  await expect(page.getByRole('button', { name: /^Deploy only on weekdays ×3/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Quote websites per page/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Quote websites per page ×/ })).toHaveCount(0);
});

import { expect, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

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
      const note = { ...notes.find(n => n.id === input.id), ...input, id: 'crud-note', slug: 'cross-device-note', pinned: false, frontmatter: {}, noteKind: 'note', tags: input.tags || [], archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes = [note];
      return json(route, 200, { note, created: !input.id, indexed: true });
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
  await page.getByPlaceholder('Untitled note').fill('Cross-device note');
  // No Save button: it saves itself a moment after typing stops, once.
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect.poll(() => notes[0]?.body).toBe('An idea captured on desktop');
  await expect(page.getByTestId('note-save-status')).toHaveText('Saved');
  expect(posts.filter(p => !p.id)).toHaveLength(1);
  expect(posts.find(p => !p.id)?.createOnly).toBe(true);
  expect(posts.filter(p => p.id).every(p => p.createOnly === undefined)).toBe(true);
  // The open note is in the address bar.
  await expect(page).toHaveURL(/\/notes\?note=crud-note$/);

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

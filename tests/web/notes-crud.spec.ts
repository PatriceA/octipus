import { expect, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

test('note create, edit, failed-save draft, reload and archive', async ({ authenticatedPage: page }) => {
  let notes: any[] = [];
  let failSave = false;
  await page.route('**/api/notes**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/\/$/, '');
    if (path === '/api/notes' && req.method() === 'POST') {
      if (failSave) return json(route, 500, { error: 'Storage unavailable' });
      const input = req.postDataJSON();
      const note = { ...input, id: 'crud-note', slug: 'cross-device-note', pinned: false, frontmatter: {}, noteKind: 'note', tags: input.tags || [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      notes = [note];
      return json(route, 200, { note, created: !input.id, indexed: true });
    }
    if (path.endsWith('/index')) return json(route, 200, { notes });
    if (path.endsWith('/tags')) return json(route, 200, { tags: [] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    if (req.method() === 'DELETE') { notes = []; return json(route, 200, { deleted: true }); }
    if (path === '/api/notes') return json(route, 200, { notes, total: notes.length });
    return json(route, 200, { ...notes[0], backlinks: [], outgoing: [] });
  });
  await page.goto('/notes');
  await page.getByTitle('New note', { exact: true }).click();
  await page.getByPlaceholder('Untitled note').fill('Cross-device note');
  await page.locator('.cm-content').fill('An idea captured on desktop');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => notes[0]?.body).toBe('An idea captured on desktop');
  await page.locator('.cm-content').fill('Keep this draft when saving fails');
  failSave = true;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Storage unavailable', { exact: false })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Keep this draft when saving fails');
  failSave = false;
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => notes[0]?.body).toBe('Keep this draft when saving fails');
  await page.reload();
  await page.getByText('Cross-device note', { exact: false }).first().click();
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Cross-device note');
  await expect(page.getByText('Keep this draft when saving fails', { exact: false }).first()).toBeVisible();
  await page.getByTitle('Archive note', { exact: true }).click();
  await expect.poll(() => notes.length).toBe(0);
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

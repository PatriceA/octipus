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

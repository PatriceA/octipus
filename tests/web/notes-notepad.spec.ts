import { expect, type Page, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

/**
 * Notes as a daily notepad: a note opens straight into its editor, its tasks
 * are checkboxes that tick the text (in the editor and the reading view), a
 * click on a `[[link]]` opens the note (an old slug of a moved one too), the
 * day's note and a one-line capture are a key away, the list is Recent first
 * with a line of each note, and notes move between folders by drag or "Move
 * to…". The API is stubbed in the browser, answering as
 * src/api/routes/notes.ts does.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** A stand-in for the server's body sha256: deterministic, 64 hex characters. */
function sha(text: string): string {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

interface StubNote {
  id: string;
  title: string;
  slug: string;
  body: string;
  noteKind?: string;
  noteDate?: string | null;
  pinned?: boolean;
  updatedAt: string;
  frontmatter?: Record<string, unknown>;
}

function full(n: StubNote) {
  return { tags: [], pinned: false, noteKind: 'note', noteDate: null, frontmatter: {}, archivedAt: null, createdAt: '2026-11-01T00:00:00Z', ...n, bodySha256: sha(n.body) };
}

async function stub(page: Page, notes: StubNote[]) {
  const calls = { posts: [] as Record<string, unknown>[], daily: [] as Record<string, unknown>[], capture: [] as Record<string, unknown>[], moves: [] as Array<{ id: string; slug: string }> };
  await page.route(/\/api\/notes(\/|\?|$)/, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^.*\/api\/notes/, '') || '/';
    if (path === '/index') return json(route, 200, { notes: notes.map((n) => ({ id: n.id, title: n.title, slug: n.slug, noteKind: n.noteKind ?? 'note', ...(Array.isArray(n.frontmatter?.aliases) ? { aliases: n.frontmatter.aliases } : {}) })) });
    if (path === '/tags') return json(route, 200, { tags: [] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    if (path === '/daily' && req.method() === 'POST') {
      const body = req.postDataJSON();
      calls.daily.push(body);
      let daily = notes.find((n) => n.slug === `daily/${body.date}`);
      if (!daily) {
        daily = { id: 'today', title: body.date, slug: `daily/${body.date}`, body: `# ${body.date}\n\n## Notes\n\n## Tasks\n`, noteKind: 'daily', noteDate: body.date, updatedAt: new Date().toISOString() };
        notes.unshift(daily);
      }
      return json(route, 200, { note: full(daily) });
    }
    if (path === '/capture' && req.method() === 'POST') {
      const body = req.postDataJSON();
      calls.capture.push(body);
      return json(route, 200, { id: 'today', slug: `daily/${body.date}` });
    }
    const move = /^\/([^/]+)\/move$/.exec(path);
    if (move && req.method() === 'POST') {
      const { slug } = req.postDataJSON();
      calls.moves.push({ id: move[1], slug });
      const n = notes.find((x) => x.id === move[1]);
      if (n) { n.frontmatter = { aliases: [n.slug] }; n.slug = slug; }
      return json(route, 200, { note: n && full(n) });
    }
    if (path === '/' && req.method() === 'POST') {
      const input = req.postDataJSON();
      calls.posts.push(input);
      const n = notes.find((x) => x.id === input.id);
      if (n) { n.body = input.body; n.title = input.title; n.updatedAt = new Date().toISOString(); }
      return json(route, 200, { note: n && full(n) });
    }
    if (path === '/') return json(route, 200, { notes: notes.map(full), total: notes.length });
    const n = notes.find((x) => x.id === path.slice(1));
    if (!n) return json(route, 404, { error: 'Note not found' });
    return json(route, 200, { ...full(n), backlinks: [], outgoing: [] });
  });
  return calls;
}

const NOTES = (): StubNote[] => [
  { id: 'shop', title: 'Shopping', slug: 'shopping', body: 'Shopping\n- [ ] oat milk\n- [x] eggs\nSee [[Garden plan]] and [[old-plans/recipes|the recipes]]', updatedAt: hoursAgo(1) },
  { id: 'garden', title: 'Garden plan', slug: 'home/garden-plan', body: 'Plant tomatoes in May.', updatedAt: hoursAgo(30) },
  { id: 'recipes', title: 'Recipes', slug: 'kitchen/recipes', body: 'Recipes\nLentil soup', updatedAt: hoursAgo(300), frontmatter: { aliases: ['old-plans/recipes'] } },
  { id: 'd-old', title: '2026-01-02', slug: 'daily/2026-01-02', body: '# 2026-01-02\nold day', noteKind: 'daily', noteDate: '2026-01-02', updatedAt: hoursAgo(10) },
  { id: 'd-new', title: '2026-01-05', slug: 'daily/2026-01-05', body: '# 2026-01-05\nnewer day', noteKind: 'daily', noteDate: '2026-01-05', updatedAt: hoursAgo(400) },
];

test('a note opens straight into its editor, and its tasks tick the text from the editor and the reading view', async ({ authenticatedPage: page }) => {
  const notes = NOTES();
  const calls = await stub(page, notes);
  await page.goto('/notes?note=shop');
  // No edit/preview switch to find first: the editor is there, with real checkboxes.
  await expect(page.locator('.cm-content')).toContainText('oat milk');
  await expect(page.getByRole('button', { name: 'edit', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Mark task done' }).click();
  await expect.poll(() => notes[0].body).toContain('- [x] oat milk');
  expect(calls.posts.at(-1)).toMatchObject({ id: 'shop', ifSha256: sha('Shopping\n- [ ] oat milk\n- [x] eggs\nSee [[Garden plan]] and [[old-plans/recipes|the recipes]]') });

  await page.getByRole('button', { name: 'Reading view' }).click();
  const reading = page.getByTestId('note-editor');
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await reading.getByRole('checkbox', { name: 'Mark task not done' }).nth(1).click();
  await expect.poll(() => notes[0].body).toContain('- [ ] eggs');
  // The save names the text the tick was made from.
  expect(calls.posts.at(-1)?.ifSha256).toBe(sha('Shopping\n- [x] oat milk\n- [x] eggs\nSee [[Garden plan]] and [[old-plans/recipes|the recipes]]'));
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.locator('.cm-content')).toBeVisible();
});

test('a click on a [[link]] opens the note, and a link to a moved note’s old slug still finds it; back and forward follow', async ({ authenticatedPage: page }) => {
  await stub(page, NOTES());
  await page.goto('/notes?note=shop');
  await page.locator('[data-wikilink="Garden plan"]').click();
  await expect(page).toHaveURL(/note=garden$/);
  await expect(page.getByPlaceholder('Untitled note')).toHaveValue('Garden plan');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/note=shop$/);
  await page.locator('[data-wikilink="old-plans/recipes"]').click();
  await expect(page).toHaveURL(/note=recipes$/);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/note=shop$/);
  await expect(page.getByRole('button', { name: 'Forward', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(page).toHaveURL(/note=recipes$/);
});

test('Today opens the day’s note by the user’s own date, T does too, and a captured line goes into it', async ({ authenticatedPage: page }) => {
  const notes = NOTES();
  const calls = await stub(page, notes);
  const today = localDay(new Date());
  await page.goto('/notes');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page).toHaveURL(/note=today$/);
  expect(calls.daily[0]).toEqual({ date: today });
  await expect(page.locator('.cm-content')).toContainText('Tasks');

  await page.goto('/notes');
  await expect(page.getByRole('button', { name: /^Shopping/ })).toBeVisible();
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/note=today$/);

  await page.goto('/notes');
  const capture = page.getByLabel('Quick note for today');
  await capture.fill('call the plumber');
  await capture.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Added to today’s note' })).toBeVisible();
  expect(calls.capture[0]).toEqual({ text: 'call the plumber', date: today });
  await expect(capture).toHaveValue('');
  await page.getByRole('button', { name: 'Open it' }).click();
  await expect(page).toHaveURL(/note=today$/);
});

test('the list is Recent first with a line of each note; A–Z sorts by title; daily notes come newest day first', async ({ authenticatedPage: page }) => {
  await stub(page, NOTES());
  await page.goto('/notes');
  const rows = page.locator('.notes-list .notes-row');
  await expect(rows.first()).toContainText('Shopping');
  // A line of the text, without the title line.
  await expect(rows.first().getByTestId('note-preview')).toHaveText('oat milk · eggs · See Garden plan and the recipes');
  await expect(page.getByRole('region', { name: 'Today' })).toContainText('Shopping');
  await page.getByRole('button', { name: /A–Z/ }).click();
  await expect(rows.first()).toContainText('Jan 2');
  await expect(rows.nth(2)).toContainText('Garden plan');
  await page.getByRole('tab', { name: 'Daily' }).click();
  await page.getByRole('button', { name: /Recent/ }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Jan 5');
  await expect(rows.nth(1)).toContainText('Jan 2');
});

test('N starts a new note with the caret in the text, / searches, and Escape lets go of the text', async ({ authenticatedPage: page }) => {
  await stub(page, NOTES());
  await page.goto('/notes');
  await expect(page.getByRole('button', { name: /^Shopping/ })).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-content')).not.toBeFocused();
  await page.keyboard.press('/');
  await expect(page.getByLabel('Search notes')).toBeFocused();
});

test('a note moves by "Move to…" or by dragging it onto a folder, keeping its name', async ({ authenticatedPage: page }) => {
  const notes = NOTES();
  const calls = await stub(page, notes);
  await page.goto('/notes?note=garden');
  await page.getByRole('button', { name: 'Details' }).click();
  await page.getByRole('dialog', { name: 'Note details' }).getByRole('button', { name: /Move to/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Move “Garden plan”' });
  await dialog.getByRole('option', { name: 'kitchen' }).click();
  await dialog.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(calls.moves).toEqual([{ id: 'garden', slug: 'kitchen/garden-plan' }]);

  await page.getByRole('button', { name: /Folders/ }).click();
  const row = page.locator('.notes-list .notes-row', { hasText: 'Shopping' });
  await row.dragTo(page.locator('[data-folder="kitchen"]'));
  await expect.poll(() => calls.moves.at(-1)).toEqual({ id: 'shop', slug: 'kitchen/shopping' });
});

test('a commenter in a space sees a note’s tasks as boxes they cannot tick', async ({ authenticatedPage: page }) => {
  const SPACE = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000003';
  await page.addInitScript((id) => localStorage.setItem('octipus.activeWorkspace', id), SPACE);
  const space = { id: SPACE, name: 'Launch', slug: 'launch', role: 'commenter', memberCount: 2, archivedAt: null, createdBy: 'x', createdAt: '2026-11-01T00:00:00Z', funding: 'own' };
  await page.route('**/api/spaces', (route) => json(route, 200, { spaces: [space] }));
  await page.route(`**/api/spaces/${SPACE}`, (route) => json(route, 200, space));
  const calls = await stub(page, NOTES());
  await page.goto('/notes?note=shop');
  const reader = page.getByTestId('note-reader');
  await expect(reader).toContainText('oat milk');
  await expect(reader.getByRole('checkbox', { name: 'Mark task done' })).toBeDisabled();
  expect(calls.posts).toEqual([]);
});

import { expect, type Page, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

/**
 * The notes editor's live preview (web/app/notes/live-preview.ts) never
 * breaks editing: over awkward markdown — constructs spanning lines,
 * unclosed ones, nesting, HTML, tables, CRLF, very long lines, front
 * matter — it draws without an error, and the document is exactly what was
 * typed (the preview only changes how text is drawn). A large note stays
 * responsive.
 */

const CORPUS: string[] = [
  '[a](\nhttp://x)\nend',
  '[a](http://x\n"Title")\nafter',
  'see [doc](\nhttps://x.y) more',
  '![img](\n/api/documents/x/raw)\n![](http://e.com/a.png "t\nitle")',
  '*em\nphasis* and **strong\nacross** lines ~~strike\nout~~',
  '`code\nspan` and ``double ` tick``',
  '**unclosed bold and *unclosed em and [unclosed link and [[unclosed wiki and `unclosed code',
  '- a\n  - b\n    - [ ] c\n      > quoted [link](\n      http://x)\n- [x] done\n-\n  [ ] box on the next line',
  '> quote\n> > nested\n> - [ ] task in quote\n>\n> [[Wiki|alias]] #tag',
  '<div>\n**not md**\n</div>\n<!-- comment\n[[x]] -->\n<span>[a](b)</span>',
  '| a | b |\n|---|---|\n| [[x]] | `y` |\n| **z** | [l](\nh) |',
  'line one\r\nline two\r\n- [ ] crlf task\r\n',
  `${'word [[link]] #tag **bold** '.repeat(400)}\n${'x'.repeat(5000)}`,
  '---\ntitle: x\ntags: [a, b]\n---\n# Heading\n\n```js\nconst a = "[b](\\nc)";\n```\n~~~\nfence ~~~ inside\n~~~',
  '# \n## #\n###### six\n#notatag\n# [[Link in heading]]\n---\n***\n___',
  '1. one\n2) two\n   1. [ ] nested ordered task\n10. [x] ten',
  '[ref]: http://example.com\n[text][ref] and [text][] and <http://auto.link> and https://bare.link',
  '\\[not a link\\](x) \\*not em\\* [[a\\|b]] #a/b/c #123 x#y',
];

/** The editor's document, as CodeMirror holds it. */
function doc(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } }) | null;
    const view = content?.cmTile?.root?.view;
    if (!view) throw new Error('no CodeMirror view on .cm-content');
    return view.state.doc.toString();
  });
}

async function openBlank(page: Page, body = 'Fuzz\n'): Promise<void> {
  const note = { id: 'fz', title: 'Fuzz', slug: 'fuzz', body, bodySha256: 'a'.repeat(64), noteKind: 'note', tags: [], pinned: false, frontmatter: {}, archivedAt: null, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  await page.route(/\/api\/notes(\/|\?|$)/, (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/notes/, '') || '/';
    if (route.request().method() === 'POST') return json(route, 200, { note: { ...note, ...route.request().postDataJSON() } });
    if (path === '/index' || path === '/') return json(route, 200, { notes: [note], total: 1 });
    if (path === '/tags') return json(route, 200, { tags: [] });
    if (path.endsWith('/suggestions')) return json(route, 200, { suggestions: [] });
    return json(route, 200, { ...note, backlinks: [], outgoing: [] });
  });
  await page.route('**/api/documents/**', (route) => json(route, 404, { error: 'not here' }));
  await page.goto('/notes?note=fz');
  await expect(page.locator('.cm-content')).toBeVisible();
}

test('awkward markdown typed a character at a time draws without an error and stays exactly the text typed', async ({ authenticatedPage: page, consoleErrors }) => {
  test.setTimeout(120_000);
  await openBlank(page);
  const failures = await page.evaluate((corpus) => {
    const content = document.querySelector('.cm-content') as HTMLElement & { cmTile: { root: { view: {
      state: { doc: { length: number; toString(): string } };
      dispatch(tr: unknown): void; focus(): void;
    } } } };
    const view = content.cmTile.root.view;
    view.focus();
    const out: string[] = [];
    for (const text of corpus) {
      // Start over with an empty note, then type the text in: the caret moves
      // through every construct, so each line is drawn with and without its markup.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
      // Long texts go in by chunks; short ones a character at a time.
      const step = text.length > 2000 ? 97 : 1;
      try {
        for (let i = 0; i < text.length;) {
          const at = view.state.doc.length;
          // A CRLF is one key (Enter), not two line breaks.
          const size = step === 1 && text.startsWith('\r\n', i) ? 2 : step;
          const piece = text.slice(i, i + size);
          i += size;
          view.dispatch({ changes: { from: at, insert: piece }, selection: { anchor: at + piece.replace(/\r\n/g, '\n').length }, userEvent: 'input.type' });
        }
        // And the caret walks back through it.
        for (let pos = view.state.doc.length; pos >= 0; pos -= Math.max(1, Math.floor(view.state.doc.length / 60))) {
          view.dispatch({ selection: { anchor: pos } });
        }
      } catch (err) {
        out.push(`${JSON.stringify(text.slice(0, 40))}: threw ${String(err)}`);
        continue;
      }
      // CodeMirror keeps lines, not line endings: CRLF reads back as LF (and is saved so).
      if (view.state.doc.toString() !== text.replace(/\r\n/g, '\n')) out.push(`${JSON.stringify(text.slice(0, 40))}: document differs`);
    }
    return out;
  }, CORPUS);
  expect(failures).toEqual([]);
  // Nothing went wrong while drawing (CodeMirror reports a plugin's error to the console), and the preview never gave up.
  expect(consoleErrors.filter((e) => !/Failed to load resource|status of 404/.test(e))).toEqual([]);
  await expect(page.locator('.cm-content')).toBeVisible();
});

test('a link typed across a line break with the keyboard stays the text typed', async ({ authenticatedPage: page, consoleErrors }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openBlank(page, 'intro\n');
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('see [doc](');
  await page.keyboard.press('Enter');
  await page.keyboard.type('https://x.y) more');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  // Every character typed is in the note, in order (the `)` the editor closed
  // the bracket with stays after it, as without the preview).
  expect(await doc(page)).toMatch(/^intro\nsee \[doc\]\(\nhttps:\/\/x\.y\) more\n?\)?$/);
  await expect(page.locator('.cm-line').nth(2)).toContainText('more');
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('a note of 5,000 lines opens and keeps up with typing', async ({ authenticatedPage: page, consoleErrors }) => {
  const lines: string[] = [];
  for (let i = 0; i < 5000; i++) {
    lines.push(i % 50 === 0 ? '```' : i % 7 === 0 ? `> quoted ${i} [[Link ${i}]]` : i % 5 === 0 ? `- [ ] task ${i} #tag` : `line ${i} with **bold** and [a](http://x/${i})`);
  }
  await openBlank(page, `Big\n${lines.join('\n')}\n`);
  // The editor shows before the note's text has loaded into it.
  await expect.poll(async () => (await doc(page)).split('\n').length).toBeGreaterThan(5000);
  const perKey = await page.evaluate(() => {
    const content = document.querySelector('.cm-content') as HTMLElement & { cmTile: { root: { view: {
      state: { doc: { line(n: number): { from: number } } }; dispatch(tr: unknown): void; focus(): void;
    } } } };
    const view = content.cmTile.root.view;
    view.focus();
    const at = view.state.doc.line(2500).from;
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) view.dispatch({ changes: { from: at + i, insert: 'x' }, selection: { anchor: at + i + 1 }, userEvent: 'input.type' });
    return (performance.now() - t0) / 100;
  });
  console.log(`live preview: ${perKey.toFixed(2)} ms per keystroke in a 5,000-line note`);
  // Well inside a frame on CI hardware; the blocks are drawn for the screen, not the whole note.
  expect(perKey).toBeLessThan(16);
  expect(consoleErrors).toEqual([]);
});

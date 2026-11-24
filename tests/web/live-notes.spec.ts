import type { Browser, Page, WebSocketRoute } from '@playwright/test';
import * as Y from 'yjs';
import { json, stubAllDefaults, stubNotes } from './fixtures/api-stubs';
import { expect, expectNoConsoleErrors, installConsoleWatchdog, STUB_TOKEN, STUB_USER, test } from './fixtures/auth';

/**
 * Live space notes (coworking spec §7.6): two members with the same note
 * open converge as they type, see each other in the note, and see "Saved".
 *
 * The server is stubbed. The two browser contexts' `/gateway` sockets meet
 * in an in-test relay that plays the document hub (src/core/docs/hub.ts):
 * it answers `doc.join` with a `doc.sync` of its Yjs document, applies each
 * `doc.update` and forwards it (and every `doc.awareness`) to the other
 * member, and acknowledges with `doc.saved`.
 */

const NOW = new Date().toISOString();
const SPACE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000002';
const NOTE_BODY = '# First note\n\nbody text\n';
const BEN = { id: 'ben-user-id', username: 'ben', email: 'ben@test.local', isAdmin: false };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, 'base64'));

class Relay {
  readonly doc = new Y.Doc();
  readonly epoch = 'epoch-1';
  private readonly sockets = new Set<WebSocketRoute>();
  readonly received: string[] = [];

  constructor() {
    this.doc.getText('body').insert(0, NOTE_BODY);
  }

  attach(ws: WebSocketRoute, userId: string): void {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Record<string, string>;
      // A space on another install: its frames come wrapped (`remote.frame`)
      // and go back as `remote.event`s of that space.
      if (message.type === 'remote.frame') {
        const remoteSpaceId = message.remoteSpaceId;
        const frame = message.frame as unknown as Record<string, string>;
        this.remote.add(ws);
        this.remoteSpaceId = remoteSpaceId;
        this.received.push(`remote:${frame.type}`);
        this.handle(ws, frame, userId);
        return;
      }
      this.received.push(message.type);
      this.handle(ws, message, userId);
    });
    ws.onClose(() => this.sockets.delete(ws));
  }

  /** Sockets that speak to this note through `remote.frame` (a member of another install). */
  private readonly remote = new Set<WebSocketRoute>();
  private remoteSpaceId = '';

  private send(ws: WebSocketRoute, message: Record<string, unknown>): void {
    ws.send(JSON.stringify(this.remote.has(ws) && String(message.type).startsWith('doc.')
      ? { type: 'remote.event', remoteSpaceId: this.remoteSpaceId, event: message }
      : message));
  }

  private handle(ws: WebSocketRoute, message: Record<string, string>, userId: string): void {
      switch (message.type) {
        case 'auth':
          this.sockets.add(ws);
          ws.send(JSON.stringify({ type: 'auth_ok', connectionId: `c-${userId}`, userId, capabilities: ['chat', 'subscribe'], serverTime: NOW, serverTimezone: 'UTC', maxFrameBytes: 262_144 }));
          break;
        case 'subscribe':
          ws.send(JSON.stringify({ type: 'permission.pending', requests: [], approvals: [] }));
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', serverTime: NOW }));
          break;
        case 'doc.join':
          this.sockets.add(ws);
          this.send(ws, {
            type: 'doc.sync', noteId: message.noteId, epoch: this.epoch,
            state: b64(Y.encodeStateAsUpdate(this.doc)), stateVector: b64(Y.encodeStateVector(this.doc)),
            readOnly: false, sha256: '', maxBytes: 114_688,
          });
          break;
        case 'doc.update':
          Y.applyUpdate(this.doc, unb64(message.update));
          this.forward(ws, { type: 'doc.update', noteId: message.noteId, epoch: this.epoch, update: message.update });
          for (const socket of this.sockets) {
            this.send(socket, { type: 'doc.saved', noteId: message.noteId, sha256: 'x', revisionId: 'r', savedAt: new Date().toISOString() });
          }
          break;
        case 'doc.awareness':
          this.forward(ws, { type: 'doc.awareness', noteId: message.noteId, update: message.update });
          break;
        default:
          break;
      }
  }

  private forward(from: WebSocketRoute, message: Record<string, string>): void {
    for (const socket of this.sockets) if (socket !== from) this.send(socket, message);
  }

  get text(): string {
    return this.doc.getText('body').toString();
  }
}

async function memberPage(browser: Browser, relay: Relay, user: typeof STUB_USER, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(({ token, user, space }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('assistant-user', JSON.stringify(user));
    localStorage.setItem('octipus.activeWorkspace', space);
  }, { token: STUB_TOKEN, user, space: SPACE_ID });
  await ctx.routeWebSocket(/\/gateway/, (ws) => relay.attach(ws, user.id));
  const page = await ctx.newPage();
  await page.route('**/api/**', (route) => json(route, 200, {}));
  await page.route('**/api/auth/me', (route) => json(route, 200, user));
  await stubAllDefaults(page);
  await stubNotes(page);
  const space = { id: SPACE_ID, name: 'Launch', slug: 'launch', role: 'editor', memberCount: 2, archivedAt: null, createdBy: 'x', createdAt: NOW, funding: 'own', agentEditMode: 'suggest' };
  await page.route('**/api/spaces', (route) => json(route, 200, { spaces: [space] }));
  await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space));
  installConsoleWatchdog(page, errors);
  return page;
}

/**
 * The editor's text: its document, as CodeMirror holds it. (The live preview
 * hides markdown markup off the caret's line, so the drawn lines are not the
 * text; other members' cursor labels are widgets, never in the document.)
 */
function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: { root?: { view?: { state: { doc: { toString(): string } } } } } }) | null;
    const view = content?.cmTile?.root?.view;
    if (!view) throw new Error('no CodeMirror view on .cm-content');
    return view.state.doc.toString();
  });
}

async function openForEditing(page: Page): Promise<void> {
  await page.goto('/notes');
  await page.getByText('First note').first().click();
  // A note opens straight into its editor.
  await expect(page.locator('.cm-content')).toContainText('body text');
}

test('two members editing a space note converge, see each other and see it saved', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  const alice = await memberPage(browser, relay, STUB_USER, consoleErrors);
  const ben = await memberPage(browser, relay, BEN, consoleErrors);
  await openForEditing(alice);
  await openForEditing(ben);

  // Both type at once, at different places.
  await alice.locator('.cm-content').click();
  await alice.keyboard.press('ControlOrMeta+End');
  const typingA = alice.keyboard.type('Alice adds a line');
  await ben.locator('.cm-line').first().click();
  await ben.keyboard.press('Home');
  const typingB = ben.keyboard.type('Ben: ');
  await Promise.all([typingA, typingB]);

  const expected = 'Ben: # First note\n\nbody text\nAlice adds a line';
  await expect.poll(() => relay.text).toBe(expected);
  await expect.poll(() => editorText(alice)).toBe(expected);
  await expect.poll(() => editorText(ben)).toBe(expected);

  // Each sees the other in the note (awareness), and the hub's "Saved".
  await expect(alice.getByTestId('note-presence')).toHaveAttribute('aria-label', /ben/);
  await expect(ben.getByTestId('note-presence')).toHaveAttribute('aria-label', /e2etest/);
  await expect(alice.getByTestId('live-status')).toContainText('Saved');
  // The body never goes through REST: Save stores the details only.
  await expect(alice.getByRole('button', { name: 'Save details' })).toBeDisabled();
  expect(relay.received).toContain('doc.join');
  expectNoConsoleErrors(consoleErrors);
});

test('a checkbox ticked in a space note, in its editor or its reading view, is a live edit the other member sees', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  relay.doc.getText('body').insert(relay.text.length, '- [ ] book the venue\n- [ ] send invites\n');
  const alice = await memberPage(browser, relay, STUB_USER, consoleErrors);
  const ben = await memberPage(browser, relay, BEN, consoleErrors);
  await openForEditing(alice);
  await openForEditing(ben);

  // In the editor the task is a real checkbox: a click edits the shared text.
  await alice.getByRole('checkbox', { name: 'Mark task done' }).first().click();
  await expect.poll(() => relay.text).toContain('- [x] book the venue');
  await expect.poll(() => editorText(ben)).toContain('- [x] book the venue');
  await expect(ben.getByRole('checkbox', { name: 'Mark task not done' })).toBeChecked();

  // The reading view's checkboxes write through the same live document.
  await ben.getByRole('button', { name: 'Reading view' }).click();
  await ben.getByTestId('note-editor').getByRole('checkbox', { name: 'Mark task done' }).click();
  await expect.poll(() => relay.text).toContain('- [x] send invites');
  await expect.poll(() => editorText(alice)).toContain('- [x] send invites');
  // Nothing went through REST.
  expect(relay.received.filter((t) => t === 'doc.update').length).toBeGreaterThanOrEqual(2);
  expectNoConsoleErrors(consoleErrors);
});

test('a note of a space on another install opens in the same editor and is edited live through remote frames', async ({ browser, consoleErrors }) => {
  const REMOTE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f0000000a';
  const NOTE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f0000000b';
  const relay = new Relay();
  relay.doc.getText('body').insert(relay.text.length, '- [ ] water the plants\n');
  const ctx = await browser.newContext();
  await ctx.addInitScript(({ token, user, space }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('assistant-user', JSON.stringify(user));
    localStorage.setItem('octipus.activeWorkspace', space);
  }, { token: STUB_TOKEN, user: STUB_USER, space: REMOTE_ID });
  await ctx.routeWebSocket(/\/gateway/, (ws) => relay.attach(ws, STUB_USER.id));
  const page = await ctx.newPage();
  await page.route('**/api/**', (route) => json(route, 200, {}));
  await page.route('**/api/auth/me', (route) => json(route, 200, STUB_USER));
  await stubAllDefaults(page);
  await page.route('**/api/remote-spaces', (route) => json(route, 200, { remoteSpaces: [{ id: REMOTE_ID, hostInstanceId: 'host-1', hostBadge: '[B:abcd1234]', hostFingerprint: 'abcd', hostUrl: 'https://host.example', spaceId: 'host-space', spaceName: 'Remote studio', role: 'editor', memberHandle: 'me', joinedAt: NOW, leftAt: null, link: 'up' }], pendingLeaves: [] }));
  const row = { id: NOTE_ID, title: 'First note', slug: 'first-note', updatedAt: NOW };
  await page.route(`**/api/remote-spaces/${REMOTE_ID}/notes`, (route) => json(route, 200, { notes: [row] }));
  await page.route(`**/api/remote-spaces/${REMOTE_ID}/notes/${NOTE_ID}`, (route) => json(route, 200, { ...row, body: relay.text, bodySha256: 'x' }));
  installConsoleWatchdog(page, consoleErrors);

  await page.goto('/notes');
  await expect(page.getByTestId('remote-notes')).toContainText('hosted by');
  await page.getByRole('button', { name: /^First note/ }).click();
  await expect(page.locator('.cm-content')).toContainText('body text');
  // The host manages its title, tags, kind and archive: only the text is edited here.
  await expect(page.getByRole('button', { name: 'Details' })).toHaveCount(0);
  await expect(page.getByTitle('Archive note')).toHaveCount(0);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('from afar');
  await expect.poll(() => relay.text).toContain('from afar');
  await page.getByRole('checkbox', { name: 'Mark task done' }).click();
  await expect.poll(() => relay.text).toContain('- [x] water the plants');
  expect(relay.received).toContain('remote:doc.join');
  await expect(page.getByTestId('live-status')).toContainText('Saved');
  expectNoConsoleErrors(consoleErrors);
  await ctx.close();
});

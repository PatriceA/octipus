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
      this.received.push(message.type);
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
          ws.send(JSON.stringify({
            type: 'doc.sync', noteId: message.noteId, epoch: this.epoch,
            state: b64(Y.encodeStateAsUpdate(this.doc)), stateVector: b64(Y.encodeStateVector(this.doc)),
            readOnly: false, sha256: '', maxBytes: 114_688,
          }));
          break;
        case 'doc.update':
          Y.applyUpdate(this.doc, unb64(message.update));
          this.forward(ws, { type: 'doc.update', noteId: message.noteId, epoch: this.epoch, update: message.update });
          for (const socket of this.sockets) {
            socket.send(JSON.stringify({ type: 'doc.saved', noteId: message.noteId, sha256: 'x', revisionId: 'r', savedAt: new Date().toISOString() }));
          }
          break;
        case 'doc.awareness':
          this.forward(ws, { type: 'doc.awareness', noteId: message.noteId, update: message.update });
          break;
        default:
          break;
      }
    });
    ws.onClose(() => this.sockets.delete(ws));
  }

  private forward(from: WebSocketRoute, message: Record<string, string>): void {
    for (const socket of this.sockets) if (socket !== from) socket.send(JSON.stringify(message));
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

/** The editor's text, without the other members' cursor labels (yCollab widgets). */
function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content')?.cloneNode(true) as HTMLElement | undefined;
    if (!content) return '';
    for (const widget of content.querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo')) widget.remove();
    return [...content.querySelectorAll('.cm-line')].map((line) => line.textContent ?? '').join('\n');
  });
}

async function openForEditing(page: Page): Promise<void> {
  await page.goto('/notes');
  await page.getByText('First note').first().click();
  await page.getByRole('button', { name: 'edit', exact: true }).click();
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

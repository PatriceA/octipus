import type { Browser, Page, WebSocketRoute } from '@playwright/test';
import { type DocHubDeps, DocumentHub, sha256Hex } from '../../src/core/docs/hub';
import type { GatewayMessage } from '../../src/core/gateway/protocol';
import { json, stubAllDefaults, stubNotes } from './fixtures/api-stubs';
import { expect, expectNoConsoleErrors, installConsoleWatchdog, STUB_TOKEN, STUB_USER, test } from './fixtures/auth';

/**
 * Edits made offline survive a reconnect (coworking spec §7.3, review
 * finding 1), through the real document hub (src/core/docs/hub.ts) rather
 * than a stub: the browser's `/gateway` socket is wired to a `DocumentHub`
 * in this process, over an in-memory note store, and `POST
 * /notes/:id/merge` to the hub's `applyExternal` as the route does.
 *
 * Alice types, her connection drops, the server restarts (shutdown flush,
 * then a fresh hub: a new epoch), she keeps typing while offline and
 * someone else changes another line of the note. On reconnect her editor
 * re-seeds onto the new document and her offline typing is merged back:
 * nothing is lost, nothing is duplicated.
 */

const NOW = new Date().toISOString();
const SPACE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000002';
const NOTE_ID = 'n1';
const NOTE_BODY = '# First note\n\nbody text\n';

/** One note of a space, in memory: what `notes.body` would hold. */
class Store {
  body = NOTE_BODY;
  sha = sha256Hex(NOTE_BODY);
  revisions = 0;

  /** A writer outside the editor changed the stored note. */
  writeAround(body: string): void {
    this.body = body;
    this.sha = sha256Hex(body);
  }
}

class Server {
  hub: DocumentHub;
  offline = false;
  private readonly sockets = new Map<string, WebSocketRoute>();
  private next = 0;

  constructor(readonly store: Store) {
    this.hub = this.makeHub();
  }

  makeHub(): DocumentHub {
    const store = this.store;
    const deps: DocHubDeps = {
      load: async (noteId) => (noteId === NOTE_ID
        ? { id: NOTE_ID, workspaceId: SPACE_ID, title: 'First note', body: store.body, bodySha256: store.sha, archivedAt: null, spaceArchived: false }
        : null),
      writeBody: async (_noteId, _ws, expected, body, sha) => {
        if (store.sha !== expected) return false;
        store.body = body;
        store.sha = sha;
        return true;
      },
      insertRevision: async () => ({ id: `rev-${++store.revisions}` }),
      reindex: async () => store.body,
      userName: async (userId) => (userId === STUB_USER.id ? STUB_USER.username : null),
      // Every peer here is a member: no guest audience to narrow.
      audience: async () => null,
      membership: async () => 'editor',
      membershipVersion: () => 0,
      send: (connectionId, message) => this.sockets.get(connectionId)?.send(JSON.stringify(message)),
      setResource: () => undefined,
      peersChanged: () => undefined,
      limits: () => ({ noteMaxBytes: 114_688, docMaxUpdatesPerSecond: 30, docPersistDebounceMs: 300, docReindexMinutes: 10, docBaseTtlMinutes: 30 }),
      now: () => Date.now(),
      keepWarmMs: 0,
    };
    return new DocumentHub(deps);
  }

  /** The process restarts: open notes are flushed (shutdown), then a fresh hub. */
  async restart(): Promise<void> {
    await this.hub.flushAll();
    this.hub = this.makeHub();
  }

  attach(ws: WebSocketRoute, userId: string): void {
    // While offline every reconnect attempt is refused.
    if (this.offline) {
      void ws.close();
      return;
    }
    const connectionId = `c-${++this.next}`;
    const conn = { connectionId, userId };
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Record<string, string>;
      switch (message.type) {
        case 'auth':
          this.sockets.set(connectionId, ws);
          ws.send(JSON.stringify({ type: 'auth_ok', connectionId, userId, capabilities: ['chat', 'subscribe'], serverTime: NOW, serverTimezone: 'UTC', maxFrameBytes: 262_144 }));
          break;
        case 'subscribe':
          ws.send(JSON.stringify({ type: 'permission.pending', requests: [], approvals: [] }));
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', serverTime: NOW }));
          break;
        case 'doc.join':
          void this.hub.join(conn, message.noteId, { epoch: message.epoch, stateVector: message.stateVector });
          break;
        case 'doc.update':
          void this.hub.update(conn, message.noteId, message.epoch, message.update);
          break;
        case 'doc.awareness':
          void this.hub.awareness(conn, message.noteId, message.update);
          break;
        case 'doc.leave':
          void this.hub.leave(connectionId, message.noteId);
          break;
        default:
          break;
      }
    });
    ws.onClose(() => {
      this.sockets.delete(connectionId);
      void this.hub.connectionClosed(connectionId);
    });
  }

  /** Drop every open socket (the network goes). */
  async dropAll(): Promise<void> {
    const open = [...this.sockets.values()];
    this.sockets.clear();
    await Promise.all(open.map((ws) => ws.close()));
  }

  liveText(): string | null {
    return this.hub.readLive(NOTE_ID)?.text ?? null;
  }
}

async function memberPage(browser: Browser, server: Server, errors: string[]): Promise<Page> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(({ token, user, space }) => {
    localStorage.setItem('auth_token', token);
    localStorage.setItem('assistant-user', JSON.stringify(user));
    localStorage.setItem('octipus.activeWorkspace', space);
  }, { token: STUB_TOKEN, user: STUB_USER, space: SPACE_ID });
  await ctx.routeWebSocket(/\/gateway/, (ws) => server.attach(ws, STUB_USER.id));
  const page = await ctx.newPage();
  await page.route('**/api/**', (route) => json(route, 200, {}));
  await page.route('**/api/auth/me', (route) => json(route, 200, STUB_USER));
  await stubAllDefaults(page);
  await stubNotes(page);
  const space = { id: SPACE_ID, name: 'Launch', slug: 'launch', role: 'editor', memberCount: 1, archivedAt: null, createdBy: 'x', createdAt: NOW, funding: 'own', agentEditMode: 'suggest' };
  await page.route('**/api/spaces', (route) => json(route, 200, { spaces: [space] }));
  await page.route(`**/api/spaces/${SPACE_ID}`, (route) => json(route, 200, space));
  // POST /notes/:id/merge, as src/api/routes/notes.ts runs it: through the hub.
  await page.route(`**/api/notes/${NOTE_ID}/merge`, async (route) => {
    const { base, text } = route.request().postDataJSON() as { base: string; text: string };
    try {
      const write = await server.hub.applyExternal(NOTE_ID, { sha256: sha256Hex(base), text: base }, text, { kind: 'peer', userId: STUB_USER.id });
      if (!write) return json(route, 404, { error: 'Note not open' });
      return json(route, 200, { changed: write.changed, merged: write.merged, sha256: write.sha256, revisionId: write.revisionId });
    } catch (err) {
      return json(route, 409, { error: err instanceof Error ? err.message : String(err), code: 'stale' });
    }
  });
  installConsoleWatchdog(page, errors);
  return page;
}

/** The editor's text, without other members' cursor labels (yCollab widgets). */
function editorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content')?.cloneNode(true) as HTMLElement | undefined;
    if (!content) return '';
    for (const widget of content.querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo')) widget.remove();
    return [...content.querySelectorAll('.cm-line')].map((line) => line.textContent ?? '').join('\n');
  });
}

test('edits typed offline survive a server restart and are merged with a change made meanwhile', async ({ browser, consoleErrors }) => {
  const store = new Store();
  const server = new Server(store);
  const page = await memberPage(browser, server, consoleErrors);
  await page.goto('/notes');
  await page.getByText('First note').first().click();
  await page.getByRole('button', { name: 'edit', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('body text');
  await expect(page.getByTestId('live-status')).toContainText('Saved');

  // Online: typed at the end, reaches the hub.
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('online line');
  await expect.poll(() => server.liveText()).toBe(`${NOTE_BODY}online line`);

  // The network goes and the server restarts (its shutdown saves the note).
  server.offline = true;
  await server.restart();
  await server.dropAll();
  expect(store.body).toBe(`${NOTE_BODY}online line`);
  await expect(page.getByTestId('live-status')).toContainText('Offline');

  // Alice keeps typing; meanwhile someone renames the heading (stored).
  await page.keyboard.type(' and offline');
  store.writeAround(`# First note, renamed\n\nbody text\nonline line`);

  // Back online: a new epoch; the offline typing is merged back, not dropped.
  server.offline = false;
  const expected = '# First note, renamed\n\nbody text\nonline line and offline';
  await expect.poll(() => server.liveText(), { timeout: 15_000 }).toBe(expected);
  await expect.poll(() => editorText(page)).toBe(expected);
  await expect(page.getByTestId('live-status')).toContainText('Saved');
  await expect.poll(() => store.body, { timeout: 5_000 }).toBe(expected);
  await expect(page.getByTestId('live-notice')).toHaveCount(0);
  expectNoConsoleErrors(consoleErrors);
});

import type { Browser, Page, Route, WebSocketRoute } from '@playwright/test';
import { json, stubAllDefaults } from './fixtures/api-stubs';
import { expect, expectNoConsoleErrors, installConsoleWatchdog, STUB_TOKEN, STUB_USER, test } from './fixtures/auth';

/**
 * Rooms of a shared space (coworking spec §6.7, §6.8): two members in two
 * browser contexts post in the same room and see each other's posts and
 * Octipus's answer, the turn strip, presence, catch-up after a reconnect,
 * removal from a private room, and the role and visibility rules.
 *
 * The server is stubbed. Both contexts' `/gateway` sockets meet in an
 * in-test relay that plays the room handlers (src/core/gateway/room-handlers.ts)
 * and the room fan-out: it stores posts, publishes `room.message`,
 * `room.turn`, `room.typing`, `room.presence` and `space.presence` to the
 * subscribers who may see them, answers `room.subscribe` with
 * `afterMessageId` with a `room.catchup`, and sends `room.removed` when a
 * member is taken out of a private room. The REST routes of the rooms
 * (src/api/routes/rooms.ts) read the same state.
 */

const SPACE_ID = '0b9d3c55-5f2c-4c37-9a3e-6d1f00000003';
const GENERAL = '7a1e0000-0000-4000-8000-000000000001';
const SECRET = '7a1e0000-0000-4000-8000-000000000002';
const DESIGN = '7a1e0000-0000-4000-8000-000000000003';
const ALICE = STUB_USER; // username 'e2etest'
const BEN = { id: 'ben-user-id', username: 'ben', email: 'ben@test.local', isAdmin: false };
type User = typeof ALICE;
type Role = 'owner' | 'editor' | 'commenter' | 'viewer';

interface RoomState {
  id: string;
  title: string;
  visibility: 'space' | 'private';
  createdBy: string;
  createdAt: string;
  /** `room_members` of a private room. */
  members: Set<string>;
  unread: Record<string, number>;
}

interface Msg {
  id: string;
  roomId: string;
  role: 'user' | 'assistant';
  content: string;
  authorUserId: string | null;
  authorName: string | null;
  agentId: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

interface Conn {
  ws: WebSocketRoute;
  userId: string;
  rooms: Set<string>;
  space: boolean;
  where: string | null;
}

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const stamp = () => new Date(Date.UTC(2026, 9, 5, 9, 0, 0, seq * 1000 + 999)).toISOString();

class Relay {
  readonly users = new Map<string, User>([[ALICE.id, ALICE], [BEN.id, BEN]]);
  readonly roles = new Map<string, Role>([[ALICE.id, 'owner'], [BEN.id, 'editor']]);
  readonly rooms = new Map<string, RoomState>();
  readonly messages: Msg[] = [];
  readonly conns: Conn[] = [];
  /** Every client frame after `auth`, with its sender. */
  readonly frames: Array<{ userId: string; message: Record<string, any> }> = [];
  running: { requesterId: string; messageId: string } | null = null;
  queued: Array<{ requesterId: string; messageId: string }> = [];

  constructor() {
    this.addRoom({ id: GENERAL, title: 'General', visibility: 'space', createdBy: ALICE.id });
    this.addRoom({ id: SECRET, title: 'Secret', visibility: 'private', createdBy: ALICE.id, members: [ALICE.id] });
  }

  addRoom(r: { id: string; title: string; visibility: 'space' | 'private'; createdBy: string; members?: string[] }): RoomState {
    const room = { ...r, createdAt: stamp(), members: new Set(r.visibility === 'private' ? [r.createdBy, ...(r.members ?? [])] : []), unread: {} };
    this.rooms.set(room.id, room);
    return room;
  }

  canEnter(userId: string, roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return !!room && (room.visibility === 'space' || room.members.has(userId));
  }

  name(userId: string): string {
    return this.users.get(userId)?.username ?? 'someone';
  }

  roomView(room: RoomState, userId: string) {
    return {
      id: room.id, workspaceId: SPACE_ID, title: room.title, visibility: room.visibility, createdBy: room.createdBy,
      createdAt: room.createdAt, updatedAt: room.createdAt, unreadCount: room.unread[userId] ?? 0, muted: false,
    };
  }

  attach(ws: WebSocketRoute, userId: string): void {
    const conn: Conn = { ws, userId, rooms: new Set(), space: false, where: null };
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Record<string, any>;
      if (message.type === 'auth') {
        this.conns.push(conn);
        this.to(conn, { type: 'auth_ok', connectionId: `c-${userId}-${this.conns.length}`, userId, capabilities: ['chat', 'subscribe'], serverTime: stamp(), serverTimezone: 'UTC', maxFrameBytes: 262_144 });
        return;
      }
      this.frames.push({ userId, message });
      this.handle(conn, message);
    });
    ws.onClose(() => this.drop(conn));
  }

  /** Close every socket of `userId` (the tab reconnects by itself). */
  disconnect(userId: string): void {
    for (const conn of this.conns.filter((c) => c.userId === userId)) {
      this.drop(conn);
      void conn.ws.close();
    }
  }

  private drop(conn: Conn): void {
    const i = this.conns.indexOf(conn);
    if (i < 0) return;
    this.conns.splice(i, 1);
    for (const roomId of conn.rooms) this.roomPresence(roomId);
    this.spacePresence();
  }

  private to(conn: Conn, message: Record<string, unknown>): void {
    conn.ws.send(JSON.stringify(message));
  }

  private event(type: string, payload: unknown, roomId?: string) {
    return { type: 'event', event: { id: uuid(), type, source: 'rooms', ...(roomId ? { sessionId: roomId } : {}), timestamp: Date.now(), payload } };
  }

  /** Send to the subscribers of the room (the resource `room:<id>`). */
  publish(roomId: string, type: string, payload: Record<string, unknown>): void {
    for (const conn of this.conns) if (conn.rooms.has(roomId)) this.to(conn, this.event(type, { roomId, ...payload }, roomId));
  }

  private snapshot() {
    const view = (r: { requesterId: string; messageId: string }) => ({ requesterId: r.requesterId, requesterName: this.name(r.requesterId), messageId: r.messageId });
    return {
      running: this.running ? { ...view(this.running), startedAt: stamp(), waiting: false, model: 'stub-model' } : null,
      queued: this.queued.map((q) => ({ ...view(q), enqueuedAt: stamp() })),
    };
  }

  private turn(roomId: string, state: string, r: { requesterId: string; messageId: string }, extra: Record<string, unknown> = {}): void {
    this.publish(roomId, 'room.turn', { state, requesterId: r.requesterId, requesterName: this.name(r.requesterId), messageId: r.messageId, ...extra, queue: this.snapshot() });
  }

  private roomPresence(roomId: string): void {
    const ids = [...new Set(this.conns.filter((c) => c.rooms.has(roomId)).map((c) => c.userId))];
    this.publish(roomId, 'room.presence', { members: ids.map((id) => ({ userId: id, username: this.name(id) })) });
  }

  /** Each subscriber gets its own view: a room it may not enter is left out of `where`. */
  spacePresence(): void {
    const online = new Map<string, string | null>();
    for (const c of this.conns) if (c.space || c.where) online.set(c.userId, c.where ?? online.get(c.userId) ?? null);
    for (const recipient of this.conns.filter((c) => c.space)) {
      const members = [...online].map(([id, where]) => ({
        userId: id, username: this.name(id), ...(where && this.canEnter(recipient.userId, where) ? { where: { kind: 'room', id: where } } : {}),
      }));
      this.to(recipient, this.event('space.presence', { spaceId: SPACE_ID, members }));
    }
  }

  /** Store a row and fan it out as `room.message`. */
  store(row: Omit<Msg, 'id' | 'createdAt'>): Msg {
    const msg = { ...row, id: uuid(), createdAt: stamp() };
    this.messages.push(msg);
    this.publish(row.roomId, 'room.message', { message: msg, ...(row.metadata.clientId ? { clientId: row.metadata.clientId } : {}) });
    return msg;
  }

  post(userId: string, roomId: string, body: { content: string; addressed?: boolean; clientId?: string }) {
    const addressed = !!body.addressed || /@octipus\b/i.test(body.content);
    const msg = this.store({
      roomId, role: 'user', content: body.content, authorUserId: userId, authorName: this.name(userId), agentId: null,
      metadata: { addressed, ...(body.clientId ? { clientId: body.clientId } : {}) },
    });
    if (!addressed) return { messageId: msg.id, clientId: body.clientId };
    const request = { requesterId: userId, messageId: msg.id };
    if (this.running) {
      this.queued.push(request);
      this.turn(roomId, 'queued', request, { position: this.queued.length });
      return { messageId: msg.id, clientId: body.clientId, queuedPosition: this.queued.length };
    }
    this.running = request;
    this.turn(roomId, 'started', request);
    return { messageId: msg.id, clientId: body.clientId, queuedPosition: 0 };
  }

  /** The running turn's final answer: stored, then the turn ends (the next one starts). */
  answer(roomId: string, content: string): void {
    const done = this.running;
    if (!done) throw new Error('No turn is running');
    this.store({ roomId, role: 'assistant', content, authorUserId: null, authorName: null, agentId: 'root-1', metadata: { replyTo: done.messageId, requesterId: done.requesterId } });
    this.running = null;
    this.turn(roomId, 'done', done, { outcome: 'success' });
    const next = this.queued.shift();
    if (next) {
      this.running = next;
      this.turn(roomId, 'started', next);
    }
  }

  /** Take `userId` out of a private room, as `onRoomAccessChanged` does. */
  removeFromRoom(roomId: string, userId: string): void {
    this.rooms.get(roomId)!.members.delete(userId);
    for (const conn of this.conns) {
      if (conn.userId === userId && conn.rooms.delete(roomId)) {
        this.to(conn, this.event('room.removed', { roomId, reason: 'You no longer have access to this room.' }, roomId));
        if (conn.where === roomId) conn.where = null;
      }
    }
    this.roomPresence(roomId);
    this.spacePresence();
  }

  private handle(conn: Conn, m: Record<string, any>): void {
    const { userId } = conn;
    switch (m.type) {
      case 'subscribe':
        this.to(conn, { type: 'permission.pending', requests: [], approvals: [] });
        return;
      case 'ping':
        this.to(conn, { type: 'pong', serverTime: stamp() });
        return;
      case 'space.subscribe':
        conn.space = true;
        this.to(conn, { type: 'subscribed', resources: [`space:${m.spaceId}`] });
        this.spacePresence();
        return;
      case 'room.subscribe': {
        if (!this.canEnter(userId, m.roomId)) {
          this.to(conn, { type: 'error', code: 'FORBIDDEN', message: `Not allowed to subscribe to room:${m.roomId}` });
          return;
        }
        conn.rooms.add(m.roomId);
        conn.where = m.roomId;
        this.to(conn, { type: 'subscribed', resources: [`room:${m.roomId}`] });
        if (m.afterMessageId) {
          const inRoom = this.messages.filter((x) => x.roomId === m.roomId);
          const from = inRoom.findIndex((x) => x.id === m.afterMessageId);
          this.to(conn, { type: 'room.catchup', roomId: m.roomId, messages: inRoom.slice(from + 1), hasMore: false });
        }
        if (this.running || this.queued.length > 0) {
          const head = this.running ?? this.queued[0];
          this.to(conn, this.event('room.turn', { roomId: m.roomId, state: this.running ? 'started' : 'queued', requesterId: head.requesterId, requesterName: this.name(head.requesterId), messageId: head.messageId, queue: this.snapshot() }, m.roomId));
        }
        this.roomPresence(m.roomId);
        this.spacePresence();
        return;
      }
      case 'room.unsubscribe':
        if (conn.rooms.delete(m.roomId)) {
          if (conn.where === m.roomId) conn.where = null;
          this.roomPresence(m.roomId);
        }
        return;
      case 'room.post': {
        if (!this.canEnter(userId, m.roomId)) {
          this.to(conn, { type: 'error', code: 'NOT_FOUND', message: 'Room not found' });
          return;
        }
        if (this.roles.get(userId) === 'viewer') {
          this.to(conn, { type: 'error', code: 'FORBIDDEN', message: 'Your role cannot post here' });
          return;
        }
        const outcome = this.post(userId, m.roomId, m as { content: string; addressed?: boolean; clientId?: string });
        this.to(conn, { type: 'room.posted', roomId: m.roomId, ...outcome });
        return;
      }
      case 'room.typing':
        for (const c of this.conns) {
          if (c !== conn && c.rooms.has(m.roomId)) this.to(c, this.event('room.typing', { roomId: m.roomId, userId, username: this.name(userId) }, m.roomId));
        }
        return;
      case 'room.cancel_queued': {
        const i = this.queued.findIndex((q) => q.messageId === m.messageId && q.requesterId === userId);
        if (i < 0) {
          this.to(conn, { type: 'error', code: 'NOT_QUEUED', message: 'That request is not waiting' });
          return;
        }
        const [cancelled] = this.queued.splice(i, 1);
        this.turn(m.roomId, 'done', cancelled, { outcome: 'cancelled' });
        return;
      }
      default:
        return;
    }
  }

  /** The REST side of the rooms (src/api/routes/rooms.ts), for `userId`. */
  async rest(route: Route, userId: string): Promise<void> {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^.*\/api\/spaces\/[^/]+/, '');
    const space = this.spaceSummary(userId);
    if (path === '' || path === '/') return json(route, 200, space);
    if (path === '/members') {
      return json(route, 200, { members: [...this.roles].map(([id, role]) => ({ userId: id, username: this.name(id), role, joinedAt: stamp() })) });
    }
    if (path === '/memory') {
      if (method === 'POST') {
        const entry = { id: uuid(), body: req.postDataJSON().body, authorKind: 'member', authorUserId: userId, authorName: this.name(userId), sessionId: null, createdAt: stamp() };
        this.memory.unshift(entry);
        return json(route, 201, entry);
      }
      return json(route, 200, { entries: this.memory });
    }
    const memoryEntry = /^\/memory\/([^/]+)$/.exec(path);
    if (memoryEntry && method === 'DELETE') {
      this.memory = this.memory.filter((e) => e.id !== memoryEntry[1]);
      return json(route, 200, { ok: true });
    }
    if (path === '/rooms') {
      if (method === 'POST') {
        const body = req.postDataJSON() as { title: string; visibility: 'space' | 'private'; memberIds?: string[] };
        this.created.push(body);
        const room = this.addRoom({ id: uuid(), title: body.title, visibility: body.visibility, createdBy: userId, members: body.memberIds });
        return json(route, 201, this.roomView(room, userId));
      }
      return json(route, 200, { rooms: [...this.rooms.values()].filter((r) => this.canEnter(userId, r.id)).map((r) => this.roomView(r, userId)) });
    }
    const room = /^\/rooms\/([^/]+)(\/.*)?$/.exec(path);
    if (!room || !this.canEnter(userId, room[1])) return json(route, 404, { error: 'Room not found' });
    const [, roomId, rest = ''] = room;
    if (rest === '' && method === 'PATCH') {
      const body = req.postDataJSON() as { title?: string };
      const r = this.rooms.get(roomId)!;
      if (body.title) r.title = body.title;
      return json(route, 200, this.roomView(r, userId));
    }
    if (rest === '/messages' && method === 'GET') {
      return json(route, 200, { messages: this.messages.filter((x) => x.roomId === roomId), hasMore: false });
    }
    if (rest === '/messages' && method === 'POST') {
      const outcome = this.post(userId, roomId, req.postDataJSON());
      return json(route, 201, outcome);
    }
    if (rest === '/members') {
      const r = this.rooms.get(roomId)!;
      const ids = r.visibility === 'private' ? [...r.members] : [...this.roles.keys()];
      return json(route, 200, { members: ids.map((id) => ({ userId: id, username: this.name(id), addedAt: null })) });
    }
    const member = /^\/members\/([^/]+)$/.exec(rest);
    if (member && method === 'DELETE') {
      this.removeFromRoom(roomId, member[1]);
      return json(route, 200, { removed: true });
    }
    if (rest === '/me') {
      const body = req.postDataJSON() as { lastReadMessageId?: string };
      if (body.lastReadMessageId) this.rooms.get(roomId)!.unread[userId] = 0;
      return json(route, 200, { ok: true });
    }
    return json(route, 404, { error: 'Not found' });
  }

  memory: Array<Record<string, unknown>> = [];
  readonly created: Array<Record<string, unknown>> = [];

  spaceSummary(userId: string) {
    return { id: SPACE_ID, name: 'Launch', slug: 'launch', role: this.roles.get(userId), memberCount: this.roles.size, archivedAt: null, createdBy: ALICE.id, createdAt: stamp(), funding: 'own' };
  }
}

async function memberPage(browser: Browser, relay: Relay, user: User, errors: string[]): Promise<Page> {
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
  await page.route('**/api/spaces', (route) => json(route, 200, { spaces: [relay.spaceSummary(user.id)] }));
  await page.route(`**/api/spaces/${SPACE_ID}/**`, (route) => relay.rest(route, user.id));
  await page.route(`**/api/spaces/${SPACE_ID}`, (route) => relay.rest(route, user.id));
  installConsoleWatchdog(page, errors);
  return page;
}

async function openRoom(page: Page, roomId = GENERAL): Promise<void> {
  await page.goto(`/rooms?room=${roomId}`);
  await expect(page.getByTestId('room-view')).toHaveAttribute('data-room-id', roomId);
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message the room' });

test('two members see each other\'s posts, the turn strip, and the final reply', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  const alice = await memberPage(browser, relay, ALICE, consoleErrors);
  const ben = await memberPage(browser, relay, BEN, consoleErrors);
  await openRoom(alice);
  await openRoom(ben);

  // Presence: each sees the other in the space header, with where.
  await expect(alice.getByTestId('presence-avatar')).toHaveAttribute('aria-label', 'ben — in #General');

  // Alice posts; Ben sees it on the left with her name, Alice on the right as hers.
  await composer(alice).fill('hello ben');
  await composer(alice).press('Enter');
  const onBen = ben.locator('[data-role="user"][data-author="e2etest"]');
  await expect(onBen).toContainText('hello ben');
  await expect(onBen).toHaveClass(/gap-3/); // the left-aligned layout, with initials
  await expect(onBen).toContainText('E2');
  await expect(alice.locator('[data-role="user"]').filter({ hasText: 'hello ben' })).toHaveClass(/justify-end/);
  await expect(alice.locator('[data-pending]')).toHaveCount(0);

  // Ben asks Octipus with the toggle: both see the turn strip.
  await ben.getByRole('switch', { name: 'Ask Octipus' }).click();
  await composer(ben).fill('summarize the launch');
  // Typing shows on the other side, and stops with the post.
  await expect(alice.getByTestId('room-typing')).toContainText('ben is typing');
  await composer(ben).press('Enter');
  await expect(alice.getByTestId('room-typing')).toHaveText('');
  await expect(alice.getByTestId('turn-strip')).toContainText('Octipus — answering ben');
  await expect(ben.getByTestId('turn-strip')).toContainText('Octipus — answering you');
  expect(relay.frames.find((f) => f.message.type === 'room.post' && f.userId === BEN.id)?.message.addressed).toBe(true);

  // Alice's own addressed post (by @octipus) waits; she may cancel it, Ben may not.
  await composer(alice).fill('@octipus and the budget?');
  await composer(alice).press('Enter');
  await expect(alice.getByTestId('queued-request')).toContainText('you');
  await expect(ben.getByTestId('queued-request')).toContainText('e2etest');
  await expect(ben.getByRole('button', { name: 'Cancel my queued request' })).toHaveCount(0);
  await alice.getByRole('button', { name: 'Cancel my queued request' }).click();
  await expect(alice.getByTestId('queued-request')).toHaveCount(0);
  await expect(ben.getByTestId('queued-request')).toHaveCount(0);

  // The final reply reaches both; the strip goes away.
  relay.answer(GENERAL, 'The launch is on track.');
  await expect(alice.locator('[data-role="assistant"]')).toContainText('The launch is on track.');
  await expect(ben.locator('[data-role="assistant"]')).toContainText('The launch is on track.');
  await expect(alice.getByTestId('turn-strip')).toHaveCount(0);

  expectNoConsoleErrors(consoleErrors);
});

test('@ completes the room\'s members', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  const alice = await memberPage(browser, relay, ALICE, consoleErrors);
  await openRoom(alice);
  await composer(alice).pressSequentially('hi @b');
  await expect(alice.getByRole('option', { name: '@ben' })).toBeVisible();
  await composer(alice).press('Enter');
  await expect(composer(alice)).toHaveValue('hi @ben ');
  expectNoConsoleErrors(consoleErrors);
});

test('a reconnecting member catches up from the last message held', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  const alice = await memberPage(browser, relay, ALICE, consoleErrors);
  const ben = await memberPage(browser, relay, BEN, consoleErrors);
  await openRoom(alice);
  await openRoom(ben);
  await composer(alice).fill('before the drop');
  await composer(alice).press('Enter');
  await expect(ben.getByText('before the drop')).toBeVisible();
  const lastSeen = relay.messages.at(-1)!.id;

  relay.disconnect(BEN.id);
  // Posted while Ben is away (through REST, as no socket of his hears it).
  relay.post(ALICE.id, GENERAL, { content: 'while you were away' });
  await expect(ben.getByTestId('room-offline')).toBeVisible();
  await expect(ben.getByText('while you were away')).toBeVisible();
  const resubscribe = relay.frames.filter((f) => f.userId === BEN.id && f.message.type === 'room.subscribe').at(-1)!;
  expect(resubscribe.message.afterMessageId).toBe(lastSeen);
  await expect(ben.getByTestId('room-offline')).toHaveCount(0);
  expectNoConsoleErrors(consoleErrors);
});

test('a viewer reads the room but cannot post or ask', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  relay.roles.set(BEN.id, 'viewer');
  relay.post(ALICE.id, GENERAL, { content: 'for everyone to read' });
  const ben = await memberPage(browser, relay, BEN, consoleErrors);
  await openRoom(ben);
  await expect(ben.getByText('for everyone to read')).toBeVisible();
  await expect(ben.getByTestId('room-read-only')).toContainText('You are a viewer in this space');
  await expect(composer(ben)).toHaveCount(0);
  await expect(ben.getByRole('button', { name: 'Ask privately' })).toHaveCount(0);
  await expect(ben.getByRole('button', { name: 'New room' })).toHaveCount(0);
  expectNoConsoleErrors(consoleErrors);
});

test('a private room is hidden from non-members; removing a member sends room.removed', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  const alice = await memberPage(browser, relay, ALICE, consoleErrors);
  const ben = await memberPage(browser, relay, BEN, consoleErrors);

  // Ben is not in Secret: not listed, not enterable, not shown in Alice's presence.
  await openRoom(ben);
  await expect(ben.getByTestId('room-link')).toHaveText(['General']);
  await ben.goto(`/rooms?room=${SECRET}`);
  await expect(ben.getByTestId('room-missing')).toContainText('does not exist, or you cannot enter it');
  await openRoom(alice, SECRET);
  await expect(ben.getByTestId('presence-avatar')).toHaveAttribute('aria-label', 'e2etest — online');

  // Alice adds Ben; he enters; then she removes him and his tab is told.
  relay.rooms.get(SECRET)!.members.add(BEN.id);
  await openRoom(ben, SECRET);
  await expect(ben.getByTestId('room-title')).toHaveText('Secret');
  await alice.reload();
  const benRow = alice.getByTestId('room-member').filter({ hasText: 'ben' });
  await expect(benRow).toBeVisible();
  alice.once('dialog', (d) => void d.accept());
  await alice.getByRole('button', { name: 'Remove ben from the room' }).click();
  await expect(ben.getByTestId('room-removed')).toContainText('#Secret: You no longer have access to this room.');
  await expect(ben.getByTestId('room-link')).toHaveText(['General']);
  await expect(alice.getByTestId('room-member')).toHaveCount(1);
  expectNoConsoleErrors(consoleErrors);
});

test('ask privately opens my private chat in the space, linked to the room', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  const alice = await memberPage(browser, relay, ALICE, consoleErrors);
  const created: Array<Record<string, any>> = [];
  await alice.route('**/api/sessions', (route) => {
    if (route.request().method() === 'POST') {
      created.push(route.request().postDataJSON());
      return json(route, 200, { id: 'priv-1', title: 'Privately about #General', status: 'active', updatedAt: stamp(), messageCount: 0, context: { linkedRoomId: GENERAL } });
    }
    return json(route, 200, { sessions: created.length ? [{ id: 'priv-1', title: 'Privately about #General', status: 'active', updatedAt: stamp(), messageCount: 0, context: { linkedRoomId: GENERAL } }] : [] });
  });
  await openRoom(alice);
  await alice.getByRole('button', { name: 'Ask privately' }).click();
  await expect(alice).toHaveURL(/\/chat\?session=priv-1$/);
  expect(created).toEqual([{ channelType: 'webchat', title: 'Privately about #General', context: { linkedRoomId: GENERAL } }]);

  // The second time, the same chat is reopened.
  await openRoom(alice);
  await alice.getByRole('button', { name: 'Ask privately' }).click();
  await expect(alice).toHaveURL(/\/chat\?session=priv-1$/);
  expect(created).toHaveLength(1);
  expectNoConsoleErrors(consoleErrors);
});

test('rooms list unread badges; an editor creates a private room; space memory', async ({ browser, consoleErrors }) => {
  const relay = new Relay();
  relay.addRoom({ id: DESIGN, title: 'Design', visibility: 'space', createdBy: BEN.id }).unread[ALICE.id] = 3;
  const alice = await memberPage(browser, relay, ALICE, consoleErrors);
  await openRoom(alice);
  await expect(alice.getByTestId('room-link').filter({ hasText: 'Design' }).getByTestId('room-unread')).toHaveText('3');
  await expect(alice.getByTestId('nav-unread-rooms')).toHaveText('3');

  // New room: private, with Ben.
  await alice.getByRole('button', { name: 'New room' }).click();
  await alice.getByRole('textbox', { name: 'Room title' }).fill('Launch plan');
  await alice.getByLabel('private — only the members I pick').check();
  await alice.getByLabel(/^ben/).check();
  await alice.getByRole('button', { name: 'create room' }).click();
  expect(relay.created).toEqual([{ title: 'Launch plan', visibility: 'private', memberIds: [BEN.id] }]);
  await expect(alice.getByTestId('room-title')).toHaveText('Launch plan');
  await expect(alice.getByTestId('room-link').filter({ hasText: 'Launch plan' })).toHaveAttribute('aria-current', 'page');

  // Space memory: add, then retract.
  await alice.getByRole('tab', { name: 'space memory' }).click();
  await alice.getByRole('textbox', { name: 'New space memory' }).fill('We ship on Thursdays');
  await alice.getByRole('button', { name: 'remember' }).click();
  await expect(alice.getByTestId('space-memory-entry')).toContainText('We ship on Thursdays');
  await alice.getByRole('button', { name: 'Retract this entry' }).click();
  await expect(alice.getByTestId('space-memory-entry')).toHaveCount(0);

  // Room settings: rename.
  await alice.getByRole('tab', { name: 'settings' }).click();
  await alice.getByRole('textbox', { name: 'Room title' }).fill('Launch plan v2');
  await alice.getByRole('button', { name: 'save' }).click();
  await expect(alice.getByTestId('room-title')).toHaveText('Launch plan v2');
  expectNoConsoleErrors(consoleErrors);
});

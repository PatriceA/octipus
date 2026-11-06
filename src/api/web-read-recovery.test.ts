import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ base: 'http://first.test/api', fetch: vi.fn() }));
vi.mock('../../web/lib/tauri-backend', () => ({ isDesktop: () => true, getDesktopApiUrl: () => fixture.base, getDesktopWsBase: () => null }));
let api: typeof import('../../web/lib/api')['api'];
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  fixture.base = 'http://first.test/api'; fixture.fetch.mockReset();
  vi.stubGlobal('fetch', fixture.fetch);
  vi.stubGlobal('localStorage', { setItem: vi.fn(), removeItem: vi.fn(), getItem: () => null });
  api = (await import('../../web/lib/api')).api;
  api.setToken('fixture-login');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(status === 429 ? { 'Retry-After': '1' } : {}) } });

test('GET retries after cooldown so initial page effects recover without a reload', async () => {
  fixture.fetch.mockResolvedValueOnce(json({ error: 'Limited' }, 429)).mockResolvedValueOnce(json({ sessions: ['available'] }));
  const read = api.get('/sessions');
  await vi.advanceTimersByTimeAsync(1500);
  expect(await read).toEqual({ sessions: ['available'] });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});
test('rate-limited mutations are never replayed', async () => {
  fixture.fetch.mockResolvedValue(json({ error: 'Limited' }, 429));
  await expect(api.post('/tasks', { title: 'One task' })).rejects.toMatchObject({ status: 429 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});
test('queued reads are cancelled if the desktop backend changes during cooldown', async () => {
  fixture.fetch.mockResolvedValue(json({ error: 'Limited' }, 429));
  const result = api.get('/sessions').catch(error => error);
  await vi.advanceTimersByTimeAsync(0);
  fixture.base = 'http://second.test/api';
  await vi.advanceTimersByTimeAsync(1500);
  expect(await result).toMatchObject({ status: 409 });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});
test('a stale read cannot log out a newer login', async () => {
  let finish!: (response: Response) => void;
  fixture.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const result = api.get('/sessions').catch(error => error);
  api.setToken('new-fixture-login');
  finish(json({ error: 'Expired old login' }, 401));
  expect(await result).toMatchObject({ status: 409 });
  expect(api.getToken()).toBe('new-fixture-login');
});
test('a read after a successful save always makes a fresh request', async () => {
  let finish!: (response: Response) => void;
  let reads = 0;
  fixture.fetch.mockImplementation((_url, options) => {
    if (options.method !== 'GET') return Promise.resolve(json({ saved: true }));
    if (++reads === 1) return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(json({ value: 'after-save' }));
  });
  const oldRead = api.get('/settings');
  await api.put('/settings', { value: 'after-save' });
  const current = await api.get('/settings');
  finish(json({ value: 'before-save' }));
  await oldRead;
  expect(current).toEqual({ value: 'after-save' });
  expect(reads).toBe(2);
});


test('polling reads surface cooldown immediately and recover without extra requests during the pause', async () => {
  fixture.fetch.mockResolvedValueOnce(json({ error: 'Limited' }, 429)).mockResolvedValue(json({ messages: ['kept'] }));
  await expect(api.get('/messages', { retryRateLimit: false })).rejects.toMatchObject({ status: 429, retryAfterMs: 1000 });
  await expect(api.get('/messages', { retryRateLimit: false })).rejects.toMatchObject({ status: 429 });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1500);
  await expect(api.get('/messages', { retryRateLimit: false })).resolves.toEqual({ messages: ['kept'] });
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});


test('learning the default workspace ID does not discard a response already read in that default', async () => {
  let finish!: (response: Response) => void;
  fixture.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const read = api.get('/models');
  api.setDefaultWorkspaceId('default');
  api.setWorkspaceId('default');
  finish(json({ models: ['available'] }));
  await expect(read).resolves.toEqual({ models: ['available'] });
});

test('a response from the default is still discarded when a different workspace is selected', async () => {
  let finish!: (response: Response) => void;
  fixture.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const read = api.get('/notes').catch(error => error);
  api.setDefaultWorkspaceId('default');
  api.setWorkspaceId('other');
  finish(json({ notes: ['private-default-note'] }));
  expect(await read).toMatchObject({ status: 409, body: { code: 'read_scope_changed' } });
});


test('a known default workspace stays bound to the original read if the default changes', async () => {
  let finish!: (response: Response) => void;
  fixture.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  api.setDefaultWorkspaceId('original-default');
  const read = api.get('/notes').catch(error => error);
  api.setDefaultWorkspaceId('new-default');
  api.setWorkspaceId('new-default');
  finish(json({ notes: ['original-default-note'] }));
  expect(await read).toMatchObject({ status: 409, body: { code: 'read_scope_changed' } });
});


test.each(['local-to-remote', 'remote-to-local', 'remote-to-remote'])('a %s selection change discards outstanding reads', async transition => {
  let finish!: (response: Response) => void;
  fixture.fetch.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  api.setDefaultWorkspaceId('default');
  if (transition === 'local-to-remote') api.setWorkspaceId('default');
  else api.setWorkspaceId('first-remote', 'remote');
  const read = api.get('/notes').catch(error => error);
  if (transition === 'remote-to-local') api.setWorkspaceId('default');
  else api.setWorkspaceId('next-remote', 'remote');
  finish(json({ notes: ['old-selection-note'] }));
  expect(await read).toMatchObject({ status: 409, body: { code: 'read_scope_changed' } });
});

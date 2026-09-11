import { afterEach, describe, expect, it } from 'vitest';
import { startCliToolBridge } from './cli-tool-bridge';

const bridges: Awaited<ReturnType<typeof startCliToolBridge>>[] = [];
afterEach(async () => { await Promise.all(bridges.splice(0).map(b => b.close())); });
async function setup(label: string) {
  let active = true;
  const bridge = await startCliToolBridge({
    active: () => active,
    tools: () => [{ name: 'read_context', description: '', parameters: { type: 'object' }, execute: async () => label }],
    execute: async () => ({ content: [{ type: 'text', text: label }] }),
  });
  bridges.push(bridge);
  return { ...bridge, stop: () => { active = false; } };
}
const call = (url: string, key: string, name = 'read_context') => fetch(`${url}/call`, {
  method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, arguments: {} }),
});
describe('CLI run capability bridge', () => {
  it('isolates simultaneous agents and rejects other capabilities', async () => {
    const a = await setup('user A/session A');
    const b = await setup('user B/session B');
    expect((await call(a.url, b.key)).status).toBe(401);
    expect(await (await call(a.url, a.key)).json()).toEqual({ content: [{ type: 'text', text: 'user A/session A' }] });
    expect(await (await call(b.url, b.key)).json()).toEqual({ content: [{ type: 'text', text: 'user B/session B' }] });
  });
  it('rejects unavailable tools, forged identity, origins, and inactive runs', async () => {
    const a = await setup('A');
    expect((await call(a.url, a.key, 'read_contex')).status).toBe(400);
    expect((await fetch(`${a.url}/call`, { method: 'POST', headers: { Authorization: `Bearer ${a.key}` },
      body: JSON.stringify({ name: 'read_context', userId: 'admin' }) })).status).toBe(400);
    expect((await fetch(`${a.url}/tools`, { headers: { Authorization: `Bearer ${a.key}`, Origin: 'https://example.com' } })).status).toBe(401);
    a.stop();
    expect((await call(a.url, a.key)).status).toBe(410);
  });
});

it('lists only registered schemas, limits bodies, and closes idempotently', async () => {
  const a = await setup('A');
  const list = await fetch(`${a.url}/tools`, { headers: { Authorization: `Bearer ${a.key}` } });
  expect(await list.json()).toMatchObject({ tools: [{ name: 'read_context', inputSchema: { type: 'object' } }] });
  const large = await fetch(`${a.url}/call`, { method: 'POST', headers: { Authorization: `Bearer ${a.key}` },
    body: JSON.stringify({ name: 'read_context', arguments: { value: 'x'.repeat(1024 * 1024) } }) });
  expect(large.status).toBe(413);
  await Promise.all([a.close(), a.close()]);
  await expect(a.close()).resolves.toBeUndefined();
});

it('answers unqueued read-only tools while a queued call still blocks the worker', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const bridge = await startCliToolBridge({
    active: () => true,
    unqueued: new Set(['get_context']),
    tools: () => ['slow_delegation', 'get_context', 'write'].map(name => ({ name, description: '', parameters: { type: 'object' }, execute: async () => null })),
    execute: async name => {
      if (name === 'slow_delegation') await blocked;
      order.push(name);
      return { content: [{ type: 'text', text: name }] };
    },
  });
  bridges.push(bridge);
  const slow = call(bridge.url, bridge.key, 'slow_delegation');
  const queuedWrite = call(bridge.url, bridge.key, 'write');
  const context = await call(bridge.url, bridge.key, 'get_context');
  expect(context.status).toBe(200);
  expect(order).toEqual(['get_context']);
  release();
  expect((await slow).status).toBe(200);
  expect((await queuedWrite).status).toBe(200);
  expect(order).toEqual(['get_context', 'slow_delegation', 'write']);
});

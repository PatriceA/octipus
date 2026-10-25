import { afterEach, describe, expect, it, vi } from 'vitest';
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

it('advertises only core schemas while discovered calls retain exact membership checks', async () => {
  const tools = ['core', 'long_tail'].map(name => ({ name, description: '', parameters: { type: 'object' }, execute: async () => null }));
  let disabled = false;
  const bridge = await startCliToolBridge({ active: () => true, tools: () => disabled ? [] : tools,
    advertisedTools: () => disabled ? [] : tools.slice(0, 1),
    execute: async (name, args) => ({ content: [{ type: 'text', text: JSON.stringify({ name, args }) }] }) });
  bridges.push(bridge);
  const headers = { Authorization: `Bearer ${bridge.key}`, 'Content-Type': 'application/json' };
  const list = await (await fetch(`${bridge.url}/tools`, { headers })).json() as any;
  expect(list.tools.map((t: any) => t.name)).toEqual(['core', 'call_discovered_tool']);
  const dispatch = (name: string) => fetch(`${bridge.url}/call`, { method: 'POST', headers,
    body: JSON.stringify({ name: 'call_discovered_tool', arguments: { name, arguments: { value: 1 } } }) });
  expect((await dispatch('long_tail')).status).toBe(200);
  expect((await dispatch('long_tai')).status).toBe(400);
  disabled = true;
  expect((await dispatch('long_tail')).status).toBe(400);
});

describe('error replies never leak internals (CodeQL js/stack-trace-exposure)', () => {
  it('an unexpected fault answers 500 with a flat message, not the thrown detail', async () => {
    const bridge = await startCliToolBridge({
      tools: () => [{ name: 'boom', description: '', parameters: {}, execute: async () => ({ content: [] }) } as never],
      active: () => true,
      execute: async () => { throw new Error('ENOENT: /srv/secret/path/internal-module.ts line 42'); },
    });
    try {
      const res = await fetch(`${bridge.url}/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'boom', arguments: {} }),
      });
      expect(res.status).toBe(500);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Tool call failed');
      expect(body.error).not.toContain('/srv/secret');
      expect(body.error).not.toContain('ENOENT');
    } finally { await bridge.close(); }
  });

  it('a deliberate refusal is still readable by the agent', async () => {
    const bridge = await startCliToolBridge({
      tools: () => [],
      active: () => true,
      execute: async () => ({ content: [] }),
    });
    try {
      const res = await fetch(`${bridge.url}/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'not_mine', arguments: {} }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe('Tool is not available to this agent');
    } finally { await bridge.close(); }
  });

  it('a blocked tool says why, since CLI agents never see the executor message', async () => {
    const bridge = await startCliToolBridge({
      tools: () => [],
      blocked: name => name === 'shell__run',
      active: () => true,
      execute: async () => ({ content: [] }),
    });
    try {
      const res = await fetch(`${bridge.url}/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bridge.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'shell__run', arguments: {} }),
      });
      expect((await res.json() as { error: string }).error).toMatch(/blocked for this run/);
    } finally { await bridge.close(); }
  });
});

it('reports a result the caller dropped before it was sent, instead of writing it to nobody', async () => {
  let release!: () => void;
  const lost: string[] = [];
  const bridge = await startCliToolBridge({
    active: () => true,
    tools: () => [{ name: 'collect_children', description: '', parameters: { type: 'object' }, execute: async () => '' }],
    execute: () => new Promise(resolve => { release = () => resolve({ content: [{ type: 'text', text: 'results' }] }); }),
    undelivered: name => { lost.push(name); },
  });
  bridges.push(bridge);
  const abort = new AbortController();
  const pending = fetch(`${bridge.url}/call`, { method: 'POST', signal: abort.signal,
    headers: { Authorization: `Bearer ${bridge.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'collect_children', arguments: {} }) }).catch(() => 'aborted');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  abort.abort();
  expect(await pending).toBe('aborted');
  await new Promise(r => setTimeout(r, 50));
  release();
  await vi.waitFor(() => expect(lost).toEqual(['collect_children']));
  // A delivered answer does not report.
  const ok = fetch(`${bridge.url}/call`, { method: 'POST',
    headers: { Authorization: `Bearer ${bridge.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'collect_children', arguments: {} }) });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await new Promise(r => setTimeout(r, 50));
  release();
  expect((await ok).status).toBe(200);
  expect(lost).toEqual(['collect_children']);
});


it('never executes a queued write after its caller disconnects', async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const writes = vi.fn();
  const bridge = await startCliToolBridge({ active: () => true,
    tools: () => ['wait', 'write'].map(name => ({name, description:'', parameters:{type:'object'}, execute:async()=>null})),
    execute: async name => { if(name === 'wait') { entered(); await waiting; } else writes(); return {content:[]}; },
  });
  bridges.push(bridge);
  const first = call(bridge.url, bridge.key, 'wait');
  await started;
  const controller = new AbortController();
  const queued = fetch(`${bridge.url}/call`, {method:'POST', signal:controller.signal,
    headers:{Authorization:`Bearer ${bridge.key}`}, body:JSON.stringify({name:'write'})});
  const rejected = expect(queued).rejects.toThrow();
  await new Promise(resolve => setTimeout(resolve, 30));
  controller.abort();
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 30));
  release();
  await first;
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(writes).not.toHaveBeenCalled();
});

it('keeps monitor reads responsive behind approval and bounds queued calls (#39)', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const executed: string[] = [];
  const bridge = await startCliToolBridge({ active: () => true, timeoutMs: 40,
    tools: () => ['wait', 'monitor__list', 'mutation'].map(name => ({ name, description: '', parameters: {}, execute: async () => null })),
    execute: async name => { executed.push(name); if (name === 'wait') await blocked; return { content: [] }; },
  });
  bridges.push(bridge);
  const waiting = call(bridge.url, bridge.key, 'wait');
  await vi.waitFor(() => expect(executed).toContain('wait'));
  const mutation = call(bridge.url, bridge.key, 'mutation');
  expect((await call(bridge.url, bridge.key, 'monitor__list')).status).toBe(200);
  expect(await (await mutation).json()).toMatchObject({ error: expect.stringContaining('not executed') });
  expect(await (await waiting).json()).toMatchObject({ error: expect.stringContaining('inspect its outcome') });
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(executed).not.toContain('mutation');
});

it("waits out a tool's own timeout and queues behind it without cutting either off (#55)", async () => {
  const executed: string[] = [];
  const bridge = await startCliToolBridge({ active: () => true, timeoutMs: 40,
    tools: () => [
      { name: 'shell__run', description: '', parameters: { type: 'object', properties: { timeout: { type: 'number', default: 60 } } }, execute: async () => null },
      { name: 'next', description: '', parameters: {}, execute: async () => null },
    ],
    execute: async name => { executed.push(name); if (name === 'shell__run') await new Promise(resolve => setTimeout(resolve, 90)); return { content: [{ type: 'text', text: name }] }; },
  });
  bridges.push(bridge);
  const gate = fetch(`${bridge.url}/call`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.key}` },
    body: JSON.stringify({ name: 'shell__run', arguments: { timeout: 120 } }) });
  await vi.waitFor(() => expect(executed).toContain('shell__run'));
  const queued = call(bridge.url, bridge.key, 'next');
  expect((await gate).status).toBe(200);
  expect((await queued).status).toBe(200);
  expect(executed).toEqual(['shell__run', 'next']);
  // Schema default counts too: 60 ms default + 40 ms base outlasts a 90 ms run.
  const byDefault = await call(bridge.url, bridge.key, 'shell__run');
  expect(byDefault.status).toBe(200);
});

it('honors the pipeline shell floor so a short requested timeout is not cut off below it (#55)', async () => {
  const bridge = await startCliToolBridge({ active: () => true, timeoutMs: 20, toolTimeoutFloorMs: 100,
    tools: () => [{ name: 'shell__run', description: '', parameters: { type: 'object', properties: { timeout: { type: 'number', default: 30 } } }, execute: async () => null }],
    execute: async () => { await new Promise(resolve => setTimeout(resolve, 80)); return { content: [] }; },
  });
  bridges.push(bridge);
  const response = await fetch(`${bridge.url}/call`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.key}` },
    body: JSON.stringify({ name: 'shell__run', arguments: { timeout: 10 } }) });
  expect(response.status).toBe(200);
});

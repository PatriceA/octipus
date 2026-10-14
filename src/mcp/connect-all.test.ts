import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import { MCPBridge, type MCPServerConnection } from './bridge';
import type { MCPServer } from '@/core/types';

// connectAll reads `mcp.autoStart` from the validated config.
const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const server = (id: string, isEnabled = true) => ({ id, name: id, isEnabled }) as unknown as MCPServer;

/** A bridge whose servers are `servers` and whose connect is `connect`. */
function bridgeWith(servers: MCPServer[], connect: (s: MCPServer) => Promise<MCPServerConnection>): MCPBridge {
  const bridge = new MCPBridge();
  const seams = bridge as unknown as { serverConfigs: MCPServer[]; loadConfig: () => Promise<void>; connect: typeof connect };
  seams.loadConfig = async () => { seams.serverConfigs = servers; };
  seams.connect = connect;
  return bridge;
}

test('servers connect in parallel, and one failing does not stop the others', async () => {
  const started: string[] = [];
  const release: Array<() => void> = [];
  const bridge = bridgeWith([server('a'), server('b'), server('off', false), server('bad')], (s) => {
    started.push(s.id);
    if (s.id === 'bad') return Promise.reject(new Error('spawn failed'));
    return new Promise((resolve) => release.push(() => resolve({} as MCPServerConnection)));
  });
  const all = bridge.connectAll();
  await new Promise((r) => setImmediate(r));
  // Both slow servers were started before either finished; the disabled one never.
  expect(started.sort()).toEqual(['a', 'b', 'bad']);
  for (const r of release) r();
  await expect(all).resolves.toBeUndefined();
});

test('boot does not wait on a slow server; a spawn waits for it, bounded', async () => {
  let finish!: () => void;
  const bridge = bridgeWith([server('slow')], () => new Promise((resolve) => { finish = () => resolve({} as MCPServerConnection); }));
  void bridge.startConnectAll();

  // Bounded: a server that hangs does not hold the spawn.
  const started = Date.now();
  await bridge.whenInitiallyConnected(50);
  expect(Date.now() - started).toBeLessThan(1000);

  // Once it is up, the wait returns at once.
  let waited = false;
  const waiting = bridge.whenInitiallyConnected(10_000).then(() => { waited = true; });
  await new Promise((r) => setImmediate(r));
  expect(waited).toBe(false);
  finish();
  await waiting;
  expect(waited).toBe(true);
});

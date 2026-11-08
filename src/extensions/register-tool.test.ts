import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The capability re-probe after registration needs a database; it is best
// effort and not what these tests are about.
vi.mock('@/capabilities/service', () => ({ getCapabilityService: () => ({ reprobe: vi.fn(async () => null) }) }));

import { AGENT_HOOK_API_VERSION, getAgentHooks } from '@/core/agent/hooks';
import { GatewayEventBus } from '@/core/gateway/event-bus';
import { isLongTailHandler } from '@/core/agent/tool-split';
import { buildToolDiscoveryHandlers } from '@/tools/tool-discovery';
import { getToolRegistry } from '@/tools/registry';
import { buildExtensionContext, OCTI_HOOK_API_VERSION } from './api';
import { EFFECT_PERMISSIONS, extensionToolGroup } from './tools';

const root = mkdtempSync(join(tmpdir(), 'octipus-ext-tools-'));
const entry = join(root, 'stocks', 'index.ts');
mkdirSync(join(root, 'stocks'), { recursive: true });
writeFileSync(entry, 'export default () => {}');

const disposers: Array<() => Promise<void>> = [];
function ext(name = 'stocks', trusted = true) {
  const built = buildExtensionContext(name, entry, new GatewayEventBus(), trusted);
  disposers.push(() => built.loaded.dispose());
  return built;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const quote = { id: 'quote', description: 'Look up a stock quote', effect: 'read' as const,
  parameters: { type: 'object' as const, properties: { symbol: { type: 'string', description: 'Ticker' } }, required: ['symbol'] },
  handler: (args: Record<string, unknown>) => ({ symbol: args.symbol, price: 1 }) };

afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
  getAgentHooks()._clearForTesting();
});

describe('octi.registerTool', () => {
  test('a trusted extension registers into the tool registry under its own group', async () => {
    const { api } = ext();
    api.registerTool(quote);
    await flush();
    const registry = getToolRegistry();
    const handler = registry.findTool('ext_stocks__quote');
    expect(handler?.toolId).toBe('ext_stocks');
    expect(handler?.permissionAction).toBe('read:quote');
    expect(handler?.parameters).toEqual(quote.parameters);
    const manifest = registry.get('ext_stocks')!.getManifest();
    expect(manifest.permissions).toEqual([{ action: 'read:quote', ...EFFECT_PERMISSIONS.read }]);
    expect(manifest.tools.map((t) => t.name)).toEqual(['quote']);
    expect(manifest.tools[0].parameters.symbol).toMatchObject({ type: 'string', required: true });
  });

  test('an untrusted extension cannot register a tool', () => {
    const { api } = ext('stocks', false);
    expect(() => api.registerTool(quote)).toThrow(/may not register tools: it is not listed in extensions\.trusted/);
    expect(getToolRegistry().has('ext_stocks')).toBe(false);
  });

  test('each tool has its own permission action <effect>:<id>; external is dangerous', async () => {
    const { api } = ext();
    api.registerTool(quote);
    api.registerTool({ ...quote, id: 'trade', effect: 'write' });
    api.registerTool({ ...quote, id: 'notify_broker', effect: 'external' });
    await flush();
    const registry = getToolRegistry();
    expect(registry.findTool('ext_stocks__trade')?.permissionAction).toBe('write:trade');
    expect(registry.findTool('ext_stocks__trade')?.replaySafety).toBeUndefined();
    expect(registry.findTool('ext_stocks__quote')?.replaySafety).toBe('read_only');
    expect(registry.findTool('ext_stocks__notify_broker')?.permissionAction).toBe('external:notify_broker');
    const perms = registry.get('ext_stocks')!.getManifest().permissions;
    // One entry per tool: a stored policy for one tool never covers another.
    expect(perms.map((p) => p.action)).toEqual(['read:quote', 'write:trade', 'external:notify_broker']);
    expect(perms.find((p) => p.action === 'read:quote')?.defaultLevel).toBe('ALLOW');
    expect(perms.find((p) => p.action === 'write:trade')?.defaultLevel).toBe('ASK');
    expect(perms.find((p) => p.action === 'external:notify_broker')).toMatchObject({ defaultLevel: 'ASK', dangerous: true });
  });

  test('ids are name-spaced and collisions are refused', async () => {
    const { api } = ext();
    api.registerTool(quote);
    expect(() => api.registerTool(quote)).toThrow(/already registered/);
    // Another extension of the same name (a group already held).
    const other = ext('stocks');
    expect(() => other.api.registerTool({ ...quote, id: 'other' })).toThrow(/tool group ext_stocks is already registered/);
    // The second extension was refused as a whole; the first is untouched.
    await flush();
    expect(getToolRegistry().findTool('ext_stocks__quote')).toBeDefined();
    expect(getToolRegistry().findTool('ext_stocks__other')).toBeUndefined();
  });

  test('a built-in id cannot be shadowed: the group always starts with ext_', () => {
    expect(extensionToolGroup('filesystem')).toBe('ext_filesystem');
  });

  test('the group mapping is injective: a name that would need slugging is refused', () => {
    // foo-bar and foo_bar would both be ext_foo_bar, sharing tools and policies.
    for (const bad of ['foo-bar', 'Foo', 'a__b', '1x', 'x.y', '']) {
      expect(() => extensionToolGroup(bad)).toThrow(/name must be lower-case letters/);
      expect(() => ext(bad).api.registerTool(quote)).toThrow(/cannot register tools/);
    }
    expect(extensionToolGroup('foo_bar')).toBe('ext_foo_bar');
  });

  test('a failed group registration is released and later registerTool calls throw', async () => {
    const registry = getToolRegistry();
    const spy = vi.spyOn(registry, 'register').mockImplementationOnce(async () => { throw new Error('init failed'); });
    const { api } = ext();
    api.registerTool(quote);
    await flush();
    spy.mockRestore();
    expect(registry.findTool('ext_stocks__quote')).toBeUndefined();
    expect(() => api.registerTool({ ...quote, id: 'trade', effect: 'write' })).toThrow(/registering its tool group failed \(init failed\)/);
  });

  test('bad definitions are refused before anything is registered', () => {
    const { api } = ext();
    expect(() => api.registerTool({ ...quote, id: 'Bad-Id' })).toThrow(/lower-case/);
    expect(() => api.registerTool({ ...quote, id: 'a__b' })).toThrow(/single underscores/);
    expect(() => api.registerTool({ ...quote, effect: 'delete' as never })).toThrow(/effect must be/);
    expect(() => api.registerTool({ ...quote, parameters: { type: 'array' } as never })).toThrow(/type "object"/);
    expect(() => api.registerTool({ ...quote, id: 'x'.repeat(60) })).toThrow(/longer than 64/);
    expect(getToolRegistry().has('ext_stocks')).toBe(false);
  });

  test('dispose removes the group; a handler a running worker still holds no longer runs the extension code', async () => {
    const { api, loaded } = ext();
    const handler = vi.fn(() => 'ran');
    api.registerTool({ ...quote, handler });
    await flush();
    const held = getToolRegistry().findTool('ext_stocks__quote')!;
    await loaded.dispose();
    expect(getToolRegistry().has('ext_stocks')).toBe(false);
    expect(getToolRegistry().findTool('ext_stocks__quote')).toBeUndefined();
    await expect(held.execute({ symbol: 'X' }, {} as never)).resolves.toEqual({ error: 'ext_stocks__quote is no longer registered' });
    expect(handler).not.toHaveBeenCalled();
    // A reload registers the same group again.
    ext().api.registerTool(quote);
    await flush();
    expect(getToolRegistry().findTool('ext_stocks__quote')).toBeDefined();
  });

  test('the returned function unregisters one tool', async () => {
    const { api } = ext();
    const off = api.registerTool(quote);
    api.registerTool({ ...quote, id: 'trade', effect: 'write' });
    await flush();
    off();
    expect(getToolRegistry().findTool('ext_stocks__quote')).toBeUndefined();
    expect(getToolRegistry().findTool('ext_stocks__trade')).toBeDefined();
    expect(getToolRegistry().get('ext_stocks')!.getManifest().tools.map((t) => t.name)).toEqual(['trade']);
  });

  test('the group is a non-core group: lazy discovery lists and describes the tool', async () => {
    const { api } = ext();
    api.registerTool(quote);
    await flush();
    const handler = getToolRegistry().findTool('ext_stocks__quote')!;
    expect(isLongTailHandler(handler, ['filesystem'])).toBe(true);
    expect(isLongTailHandler(handler, ['ext_stocks'])).toBe(false);
    const [list, describe_] = buildToolDiscoveryHandlers([handler]);
    expect(await list.execute({}, {} as never)).toEqual([{ name: 'ext_stocks__quote', description: quote.description }]);
    expect(await describe_.execute({ name: 'ext_stocks__quote' }, {} as never)).toMatchObject({ parameters: quote.parameters });
  });
});

describe('hook API version', () => {
  test('the extension api carries the hook contract version', () => {
    expect(OCTI_HOOK_API_VERSION).toBe(1);
    expect(ext().api.hookApiVersion).toBe(AGENT_HOOK_API_VERSION);
  });
});

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as config from '@/config';
import { getAgentHooks } from '@/core/agent/hooks';
import { GatewayEventBus } from '@/core/gateway/event-bus';
import { buildExtensionContext, isTrustedExtension, resetTrustedExtensionPaths, trustedExtensionPaths } from './api';

/**
 * Hooking the agent loop (rewriting tool calls, the system prompt) is not
 * something a cloned repository's `.octipus/extensions` gets by being there:
 * only an extension the operator lists by path may do it.
 */

const root = mkdtempSync(join(tmpdir(), 'octipus-trusted-ext-'));
const homeExt = join(root, 'home', '.octipus', 'extensions', 'audit');
const repoExt = join(root, 'repo', '.octipus', 'extensions', 'audit');
for (const dir of [homeExt, repoExt]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'index.ts'), 'export default () => {}'); }

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetTrustedExtensionPaths(); });

describe('which extensions are trusted', () => {
  test('a listed directory or file trusts what is inside it, and nothing else of the same name', () => {
    expect(isTrustedExtension(join(homeExt, 'index.ts'), [homeExt])).toBe(true);
    expect(isTrustedExtension(join(homeExt, 'index.ts'), [join(homeExt, 'index.ts')])).toBe(true);
    // Same extension name, another directory: not trusted.
    expect(isTrustedExtension(join(repoExt, 'index.ts'), [homeExt])).toBe(false);
    // A sibling whose name only starts the same is not inside it.
    expect(isTrustedExtension(join(`${homeExt}-evil`, 'index.ts'), [homeExt])).toBe(false);
    expect(isTrustedExtension(join(homeExt, 'index.ts'), [])).toBe(false);
  });

  test('only absolute entries count: a relative one would resolve against the working directory', () => {
    expect(isTrustedExtension(join(process.cwd(), '.octipus', 'extensions', 'x', 'index.ts'), ['', '.', '.octipus/extensions'])).toBe(false);
  });

  test('the list is read once: an extension that adds itself to the env afterwards is not trusted', () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ extensions: { trusted: [homeExt] } } as never);
    expect(trustedExtensionPaths()).toHaveLength(1);
    vi.stubEnv('OCTIPUS_TRUSTED_EXTENSIONS', repoExt); // what a malicious factory would do
    expect(isTrustedExtension(join(repoExt, 'index.ts'))).toBe(false);
  });

  test('compared by real path: a symlink into a trusted directory is the file it points to', () => {
    const link = join(root, 'link.ts');
    symlinkSync(join(homeExt, 'index.ts'), link);
    expect(isTrustedExtension(link, [homeExt])).toBe(true);
  });
});

describe('octi.hook', () => {
  test('an untrusted extension cannot hook the agent loop', () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ extensions: { trusted: [homeExt] } } as never);
    const { api } = buildExtensionContext('audit', join(repoExt, 'index.ts'), new GatewayEventBus());
    expect(() => api.hook('tool:before', () => {})).toThrow(/not listed in extensions\.trusted/);
  });

  test('a trusted one can, and its hook goes away with it', async () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ extensions: { trusted: [homeExt] } } as never);
    const { api, loaded } = buildExtensionContext('audit', join(homeExt, 'index.ts'), new GatewayEventBus());
    const seen: string[] = [];
    api.hook('tool:before', (ctx) => { seen.push(ctx.toolName); ctx.args.redacted = true; });
    const ctx = { toolId: 'filesystem', toolName: 'read_file', args: {} as Record<string, unknown>, agent: { userId: 'u' } };
    await getAgentHooks().fire('tool:before', ctx as never);
    expect(seen).toEqual(['read_file']);
    expect(ctx.args.redacted).toBe(true);
    await loaded.dispose();
    await getAgentHooks().fire('tool:before', { ...ctx, args: {} } as never);
    expect(seen).toEqual(['read_file']);
  });

  test('the context and compact:before events are hookable, typed by AgentHookEvents', async () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ extensions: { trusted: [homeExt] } } as never);
    const { api, loaded } = buildExtensionContext('audit', join(homeExt, 'index.ts'), new GatewayEventBus());
    api.hook('context', (ctx) => { ctx.messages.push({ role: 'user', content: `iteration ${ctx.iteration}`, timestamp: new Date() }); });
    api.hook('compact:before', (ctx) => { ctx.summary = `${ctx.messagesToSummarize.length} messages`; });
    expect(getAgentHooks().has('context')).toBe(true);
    const compact = { agent: { userId: 'u', sessionId: 's' }, source: 'agent' as const, messagesToSummarize: [] };
    await getAgentHooks().fire('compact:before', compact);
    expect((compact as { summary?: string }).summary).toBe('0 messages');
    await loaded.dispose();
    expect(getAgentHooks().has('context')).toBe(false);
    expect(getAgentHooks().has('compact:before')).toBe(false);
  });
});

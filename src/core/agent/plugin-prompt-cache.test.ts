/**
 * Prompt sections of plugin packages (docs/PLUGIN-PACKAGES.md#prompt-sections)
 * ride the install tier (C3): static files, the same bytes for every user, so
 * two users' root prompts still share one cached install block — with the
 * section in it while the package is enabled, and without it once disposed.
 *
 * Assembled from the real pieces the root runner uses (root-request-fixture).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/core/personas/resolver', () => ({
  resolvePersonaForUser: async (userId: string) => ({
    promptBlock: `--- PERSONA ---\nYou are ${userId === 'alice' ? 'Ada' : 'Bix'}.\n\n--- END PERSONA ---\n\n`,
  }),
}));

import type { CompletionOptions } from '@/models/litellm-client';
import { _resetPersonaHookForTesting, installPersonaHook } from '@/core/personas/persona-hook';
import { bindPrompt, pluginPromptSections } from '@/plugins/packages/contributions/prompt';
import { getAgentHooks } from './hooks';
import { assembleRootPrompt, nativeRequestBody, rootSystemMessages } from './root-request-fixture';

const SECTION = 'When the user asks for an invoice, use the billing plugin.';

const systemOf = async (userId: string) => {
  const prompt = await assembleRootPrompt({ userId, workspace: `/w/${userId}` });
  const body = nativeRequestBody({
    model: 'claude-sonnet-4-6',
    messages: [...rootSystemMessages(prompt).messages, { role: 'user', content: 'now', timestamp: new Date() }] as CompletionOptions['messages'],
    tools: [],
    cacheScope: 'root:g1',
    cachePacing: 'human',
  });
  return { prompt, system: body.system as Array<{ text: string; cache_control?: unknown }> };
};

describe('plugin prompt sections in the install tier', () => {
  const disposers: Array<() => void> = [];
  beforeEach(() => {
    getAgentHooks()._clearForTesting();
    _resetPersonaHookForTesting();
    installPersonaHook();
  });
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
    getAgentHooks()._clearForTesting();
    _resetPersonaHookForTesting();
  });

  test('present for every user as the same bytes, inside the cached install block', async () => {
    disposers.push(bindPrompt('billing', `${SECTION}\n`, undefined));
    const [a, b] = await Promise.all([systemOf('alice'), systemOf('bob')]);
    expect(a.prompt.installPrefix()).toContain(SECTION);
    expect(a.prompt.installPrefix()).not.toContain('PERSONA');
    expect(a.prompt.installPrefix()).toBe(b.prompt.installPrefix());
    expect(a.system[0]).toEqual(b.system[0]);
    expect(a.system[0].text).toContain(SECTION);
    expect(a.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(a.prompt.summary().find((t) => t.tier === 'install')?.labels).toContain('plugin-prompt:billing');
  });

  test('absent once disposed, and the install block is what it was without it', async () => {
    const before = (await systemOf('alice')).prompt.installPrefix();
    const dispose = bindPrompt('billing', SECTION, undefined);
    expect((await systemOf('alice')).prompt.installPrefix()).not.toBe(before);
    dispose();
    expect((await systemOf('alice')).prompt.installPrefix()).toBe(before);
  });

  test('ordered by package name whatever the binding order; filtered by role', () => {
    disposers.push(bindPrompt('zeta', 'Z', undefined), bindPrompt('alpha', 'A', ['general']), bindPrompt('mid', 'M', ['researcher']));
    expect(pluginPromptSections('general').map((s) => s.label)).toEqual(['plugin-prompt:alpha', 'plugin-prompt:zeta']);
    expect(pluginPromptSections('researcher').map((s) => s.label)).toEqual(['plugin-prompt:mid', 'plugin-prompt:zeta']);
  });
});

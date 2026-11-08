/**
 * C3: the install tier — security preamble, role prompt, delegation policy and
 * mechanics — opens every root prompt as the same bytes for every user of the
 * install, and reaches Anthropic as a system block of its own with a cache
 * breakpoint, so two users' requests share the tools and that block in one
 * cache entry.
 *
 * The prompt is assembled from the real pieces the root runner uses (the role
 * config, the persona hook, the delegation text, the builder, the agent
 * manager's split) and sent through the real native request builder.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/core/personas/resolver', () => ({
  // The rendered shape of a real persona block (resolver.ts renderPromptBlock).
  resolvePersonaForUser: async (userId: string) => ({
    promptBlock: `--- PERSONA ---\nYou are ${userId === 'alice' ? 'Ada' : 'Bix'}, tone ${userId === 'alice' ? 'dry' : 'warm'}.\n\nADDITIONAL FACTS THE USER HAS SET ABOUT YOU:\n- ${userId} likes tea\n\n--- END PERSONA ---\n\n`,
  }),
}));

import type { CompletionOptions } from '@/models/litellm-client';
import { AnthropicProvider } from '@/models/providers/anthropic-provider';
import { applyAnthropicCacheControl } from '@/models/providers/prompt-cache';
import type { AgentMessage } from '@/core/types';
import { estimateTokens } from '@/utils/token-count';
import { _resetPersonaHookForTesting, installPersonaHook } from '@/core/personas/persona-hook';
import { type BuildSystemPromptOptions, getAgentHooks } from './hooks';
import { asTrailingBlock, PromptBuilder, splitSharedPrefix } from './prompt-builder';
import { getRoleConfig, SECURITY_PREAMBLE } from './roles';
import { buildDelegationPolicy, splitHookedRolePrompt } from './root-runner';
import { ROOT_ROLE } from './types';
import delegationPrompt from './delegation-prompt.md';

const DATE = '\n\nCURRENT DATE & TIME: Sun, 08 Nov 2026 12:00:00 GMT';

/** The root runner's assembly, in its order, for one user's turn. */
async function rootPrompt(userId: string, workspace: string, isLite = false): Promise<PromptBuilder> {
  const config = getRoleConfig(ROOT_ROLE);
  const base = isLite ? (config.liteSystemPromptTemplate ?? config.systemPromptTemplate) : config.systemPromptTemplate;
  const hookInput: BuildSystemPromptOptions = { role: ROOT_ROLE, root: true, userId, sessionId: `s-${userId}`, workspaceId: null, systemPrompt: base };
  const ctx = await getAgentHooks().fire('before-agent-start', hookInput);
  const split = splitHookedRolePrompt(base, ctx.systemPrompt);
  if (!split) throw new Error('persona hook output not recognised');
  const prompt = new PromptBuilder()
    .add('install', 'role-prompt', split.install)
    .add('install', 'delegation-policy', buildDelegationPolicy(isLite));
  if (!isLite) prompt.add('install', 'delegation-mechanics', `\n\n${delegationPrompt}`);
  return prompt
    .add('user', 'persona', asTrailingBlock(split.user))
    .add('session', 'workspace-listing', `\nWORKSPACE: Root is ${workspace}`, { drifts: true })
    .add('turn', 'turn-context', DATE);
}

/** What the agent manager hands the worker: the install tier flagged, then the rest. */
function systemMessages(prompt: PromptBuilder): AgentMessage[] {
  const built = prompt.build();
  const split = splitSharedPrefix(built, prompt.installPrefix());
  if (!split) throw new Error('no install split');
  // The worker moves the turn tier into the user message (addSystemMessage).
  const rest = split.rest.slice(0, split.rest.indexOf(DATE));
  return [
    { role: 'system', content: split.shared, cacheBreak: true, timestamp: new Date() },
    { role: 'system', content: rest, timestamp: new Date() },
  ];
}

const tools: CompletionOptions['tools'] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'spawn_child', description: 'Delegate', parameters: { type: 'object', properties: { role: { type: 'string' } } } } },
];

const nativeBody = (messages: AgentMessage[]) =>
  (new AnthropicProvider() as unknown as { buildNativeBody(o: CompletionOptions, s: boolean): Record<string, unknown> }).buildNativeBody({
    model: 'claude-sonnet-4-6',
    messages: [
      ...messages,
      { role: 'user', content: 'earlier question', timestamp: new Date() },
      { role: 'assistant', content: 'earlier answer', timestamp: new Date() },
      { role: 'user', content: 'now', timestamp: new Date() },
    ] as CompletionOptions['messages'],
    tools,
    cacheScope: 'root:g1',
    cachePacing: 'human',
  }, false);

const countBreakpoints = (body: unknown) => JSON.stringify(body).split('"cache_control"').length - 1;

describe('install tier (C3)', () => {
  beforeEach(() => {
    getAgentHooks()._clearForTesting();
    _resetPersonaHookForTesting();
    installPersonaHook();
  });
  afterEach(() => {
    getAgentHooks()._clearForTesting();
    _resetPersonaHookForTesting();
  });

  test('the persona leaves the install tier: role prompt and delegation first, persona after them', async () => {
    const prompt = await rootPrompt('alice', '/w/alice');
    const install = prompt.installPrefix();
    expect(install.startsWith(SECURITY_PREAMBLE)).toBe(true);
    expect(install).not.toContain('PERSONA');
    expect(install).toContain(delegationPrompt.trim().slice(0, 80));
    expect(prompt.staticBlocksByTier().map((b) => b.tier)).toEqual(['install', 'user', 'session']);
    expect(prompt.staticBlocksByTier().map((b) => b.text).join('')).toBe(prompt.staticParts().join(''));
    const user = prompt.staticBlocksByTier()[1].text;
    expect(user.startsWith('\n\n--- PERSONA ---')).toBe(true);
    expect(user).toContain('alice likes tea');
  });

  test('two users: byte-identical tools and install block, different blocks after it', async () => {
    const [a, b] = await Promise.all([rootPrompt('alice', '/w/alice'), rootPrompt('bob', '/w/bob')]);
    const bodyA = nativeBody(systemMessages(a));
    const bodyB = nativeBody(systemMessages(b));
    expect(JSON.stringify(bodyA.tools)).toBe(JSON.stringify(bodyB.tools));
    const sysA = bodyA.system as Array<{ text: string; cache_control?: unknown }>;
    const sysB = bodyB.system as Array<{ text: string; cache_control?: unknown }>;
    expect(sysA[0]).toEqual(sysB[0]);
    expect(sysA[0].text).toBe(a.installPrefix());
    expect(sysA[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(sysA[1].text).not.toBe(sysB[1].text);
    expect(sysA[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // The blocks are the prompt the model reads, unchanged by the split.
    expect(sysA.map((s) => s.text).join('')).toBe(a.staticParts().join(''));

    // The shared prefix is worth caching on its own: above every Claude
    // model's minimum (1,024–4,096 tokens) for the full tier.
    expect(estimateTokens(a.installPrefix())).toBeGreaterThan(4096);
  });

  test('four breakpoints at most: tools, install tier, system end, history — 1h before 5m', async () => {
    const body = nativeBody(systemMessages(await rootPrompt('alice', '/w/alice')));
    expect(countBreakpoints(body)).toBe(4);
    const toolsList = body.tools as Array<{ cache_control?: unknown }>;
    expect(toolsList.at(-1)?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const messages = body.messages as Array<{ content: Array<{ cache_control?: unknown }> }>;
    const history = messages.flatMap((m) => m.content).filter((c) => c.cache_control);
    expect(history).toEqual([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]);
  });

  test('lite tier: the same layout, a smaller shared prefix', async () => {
    const [a, b] = await Promise.all([rootPrompt('alice', '/w/a', true), rootPrompt('bob', '/w/b', true)]);
    const sysA = nativeBody(systemMessages(a)).system as Array<{ text: string }>;
    const sysB = nativeBody(systemMessages(b)).system as Array<{ text: string }>;
    expect(sysA[0].text).toBe(sysB[0].text);
    expect(estimateTokens(a.installPrefix())).toBeLessThan(estimateTokens((await rootPrompt('alice', '/w/a')).installPrefix()));
  });

  test('OpenAI-compat pass-through (LiteLLM, OpenRouter): the install message and the system end are marked, three in all', async () => {
    const msgs = systemMessages(await rootPrompt('alice', '/w/alice')).map((m) => ({ role: 'system' as const, content: m.content }));
    const wire = [...msgs, { role: 'user' as const, content: 'earlier' }, { role: 'user' as const, content: 'now' }];
    applyAnthropicCacheControl(wire, 'claude-sonnet-4-6', { conversation: true });
    expect(countBreakpoints(wire)).toBe(3);
    expect(JSON.stringify(wire[0])).toContain('cache_control');
    expect(JSON.stringify(wire[1])).toContain('cache_control');
  });
});

describe('splitHookedRolePrompt', () => {
  const base = `${SECURITY_PREAMBLE}ROLE`;
  test('the persona hook\'s insertion after the preamble', () => {
    expect(splitHookedRolePrompt(base, `${SECURITY_PREAMBLE}PERSONA\n\nROLE`)).toEqual({ install: base, user: 'PERSONA\n\n' });
  });
  test('an appended or prepended addition', () => {
    expect(splitHookedRolePrompt(base, `${base}\n\nEXTRA`)).toEqual({ install: base, user: '\n\nEXTRA' });
    expect(splitHookedRolePrompt('ROLE', 'P ROLE')).toEqual({ install: 'ROLE', user: 'P ' });
  });
  test('no hook output: the whole role prompt is install, nothing user', () => {
    expect(splitHookedRolePrompt(base, base)).toEqual({ install: base, user: '' });
  });
  test('a rewrite is not separated', () => {
    expect(splitHookedRolePrompt(base, `${SECURITY_PREAMBLE}OTHER`)).toBeNull();
    expect(splitHookedRolePrompt(base, 'short')).toBeNull();
  });
});

describe('splitSharedPrefix', () => {
  test('drops the blank line the provider join puts back', () => {
    expect(splitSharedPrefix('AAA\n\nBBB', 'AAA')).toEqual({ shared: 'AAA', rest: 'BBB' });
  });
  test('keeps one message when nothing static follows, or the prefix moved', () => {
    expect(splitSharedPrefix(`AAA${DATE}`, 'AAA')).toBeNull();
    expect(splitSharedPrefix('AAA', 'AAA')).toBeNull();
    expect(splitSharedPrefix('XAAA\n\nB', 'AAA')).toBeNull();
    expect(splitSharedPrefix('AAA\n\nB', '')).toBeNull();
  });
});

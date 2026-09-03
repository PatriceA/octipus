import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { type BuildSystemPromptOptions, getAgentHooks } from '@/core/agent/hooks';
import { SECURITY_PREAMBLE } from '@/core/agent/roles';
import { _resetPersonaHookForTesting, installPersonaHook } from './persona-hook';
import { getPersonaRegistry } from './registry';
import { Persona } from './types';

const TEST_PERSONA = Persona.parse({
  id: 'octipus',
  is_default: true,
  display_name: 'Octipus',
  name: 'Octipus',
  pronouns: 'it/we',
  tone: 'dry',
  persona_prompt:
    'You are Octipus, the octopus-machine. Refer to yourself in third person. Never "I".',
  signature_phrases: ['Acknowledged.'],
});

const baseCtx = (overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions => ({
  role: 'general',
  root: true,
  userId: 'user-test',
  sessionId: 'session-test',
  workspaceId: null,
  systemPrompt: SECURITY_PREAMBLE + 'ROLE_PROMPT_TEXT',
  ...overrides,
});

describe('installPersonaHook', () => {
  beforeEach(() => {
    getAgentHooks()._clearForTesting();
    _resetPersonaHookForTesting();
    getPersonaRegistry()._setForTesting([TEST_PERSONA]);
  });

  afterEach(() => {
    getAgentHooks()._clearForTesting();
    _resetPersonaHookForTesting();
    getPersonaRegistry()._resetForTesting();
  });

  test('injects the persona block AFTER SECURITY_PREAMBLE, BEFORE the role prompt', async () => {
    installPersonaHook();
    const ctx = baseCtx();
    await getAgentHooks().fire('before-agent-start', ctx);

    expect(ctx.systemPrompt.startsWith(SECURITY_PREAMBLE)).toBe(true);
    const afterPreamble = ctx.systemPrompt.slice(SECURITY_PREAMBLE.length);
    expect(afterPreamble.startsWith('--- PERSONA ---')).toBe(true);
    expect(ctx.systemPrompt).toContain('ROLE_PROMPT_TEXT');
    expect(ctx.systemPrompt.indexOf('PERSONA')).toBeLessThan(
      ctx.systemPrompt.indexOf('ROLE_PROMPT_TEXT'),
    );
  });

  test('persona block contains the persona name and prompt body', async () => {
    installPersonaHook();
    const ctx = baseCtx();
    await getAgentHooks().fire('before-agent-start', ctx);
    expect(ctx.systemPrompt).toContain('Octipus');
    expect(ctx.systemPrompt).toContain('octopus-machine');
    expect(ctx.systemPrompt).toContain('third person');
  });

  test('skips injection for spawned children (not the root)', async () => {
    installPersonaHook();
    const ctx = baseCtx({ role: 'coding', root: false, systemPrompt: SECURITY_PREAMBLE + 'CODING_ROLE' });
    await getAgentHooks().fire('before-agent-start', ctx);
    expect(ctx.systemPrompt).toBe(SECURITY_PREAMBLE + 'CODING_ROLE');
  });

  test('prepends whole block when prompt does NOT start with SECURITY_PREAMBLE (unit-test path)', async () => {
    installPersonaHook();
    const ctx = baseCtx({ systemPrompt: 'NO_PREAMBLE_HERE' });
    await getAgentHooks().fire('before-agent-start', ctx);
    expect(ctx.systemPrompt.startsWith('--- PERSONA ---')).toBe(true);
    expect(ctx.systemPrompt).toContain('NO_PREAMBLE_HERE');
  });

  test('SECURITY_PREAMBLE is preserved verbatim — DESIGN.md rule #6', async () => {
    installPersonaHook();
    const ctx = baseCtx();
    await getAgentHooks().fire('before-agent-start', ctx);
    expect(ctx.systemPrompt.startsWith(SECURITY_PREAMBLE)).toBe(true);
  });

  test('double-install is a no-op', async () => {
    installPersonaHook();
    installPersonaHook();
    installPersonaHook();
    expect(getAgentHooks()._count('before-agent-start')).toBe(1);
  });
});

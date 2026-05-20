import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type BuildSystemPromptOptions, getOrchestratorHooks } from '@/core/orchestrator/hooks';
import { SECURITY_PREAMBLE } from '@/core/orchestrator/roles';
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
  role: 'orchestrator',
  userId: 'user-test',
  sessionId: 'session-test',
  workspaceId: null,
  systemPrompt: SECURITY_PREAMBLE + 'ROLE_PROMPT_TEXT',
  ...overrides,
});

describe('installPersonaHook', () => {
  beforeEach(() => {
    getOrchestratorHooks()._clearForTesting();
    _resetPersonaHookForTesting();
    getPersonaRegistry()._setForTesting([TEST_PERSONA]);
  });

  afterEach(() => {
    getOrchestratorHooks()._clearForTesting();
    _resetPersonaHookForTesting();
    getPersonaRegistry()._resetForTesting();
  });

  test('injects the persona block AFTER SECURITY_PREAMBLE, BEFORE the role prompt', async () => {
    installPersonaHook();
    const ctx = baseCtx();
    await getOrchestratorHooks().fire('before-agent-start', ctx);

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
    await getOrchestratorHooks().fire('before-agent-start', ctx);
    expect(ctx.systemPrompt).toContain('Octipus');
    expect(ctx.systemPrompt).toContain('octopus-machine');
    expect(ctx.systemPrompt).toContain('third person');
  });

  test('skips injection for non-orchestrator roles', async () => {
    installPersonaHook();
    const ctx = baseCtx({ role: 'coding', systemPrompt: SECURITY_PREAMBLE + 'CODING_ROLE' });
    await getOrchestratorHooks().fire('before-agent-start', ctx);
    expect(ctx.systemPrompt).toBe(SECURITY_PREAMBLE + 'CODING_ROLE');
  });

  test('prepends whole block when prompt does NOT start with SECURITY_PREAMBLE (unit-test path)', async () => {
    installPersonaHook();
    const ctx = baseCtx({ systemPrompt: 'NO_PREAMBLE_HERE' });
    await getOrchestratorHooks().fire('before-agent-start', ctx);
    expect(ctx.systemPrompt.startsWith('--- PERSONA ---')).toBe(true);
    expect(ctx.systemPrompt).toContain('NO_PREAMBLE_HERE');
  });

  test('SECURITY_PREAMBLE is preserved verbatim — DESIGN.md rule #6', async () => {
    installPersonaHook();
    const ctx = baseCtx();
    await getOrchestratorHooks().fire('before-agent-start', ctx);
    expect(ctx.systemPrompt.startsWith(SECURITY_PREAMBLE)).toBe(true);
  });

  test('double-install is a no-op', async () => {
    installPersonaHook();
    installPersonaHook();
    installPersonaHook();
    expect(getOrchestratorHooks()._count('before-agent-start')).toBe(1);
  });
});

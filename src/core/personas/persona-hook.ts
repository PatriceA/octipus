import { getAgentHooks } from '@/core/agent/hooks';
import { SECURITY_PREAMBLE } from '@/core/agent/roles';
import { coreLogger } from '@/utils/logger';
import { installNarrationBridge } from './narration-bridge';
import { getPersonaRegistry } from './registry';
import { resolvePersonaForUser } from './resolver';

/**
 * Wire the persona system into the root agent. Call once at startup
 * (idempotent — safe to call multiple times; only one subscriber
 * registers thanks to the module-level guard).
 *
 * Subscription contract: when `before-agent-start` fires for the turn's ROOT
 * agent, we inject the resolved persona block AFTER the
 * SECURITY_PREAMBLE and BEFORE the role prompt. The root runner then moves
 * the block behind the install tier (`splitHookedRolePrompt`, C3), so the
 * prompt the model reads is:
 *
 *   SECURITY_PREAMBLE  (untouched — DESIGN.md rule #6)
 *   ROLE PROMPT        (the root role's prompt.md, untouched)
 *   DELEGATION         (policy and mechanics — with the above, the install tier)
 *   PERSONA            (this module — name, tone, voice rules, user facts)
 *   (workspace, memory, session summary, etc. — appended downstream)
 *
 * Specialist children are out of scope: persona is host-level only.
 * We bail when the hook fires for anything but the root agent.
 */
let registered = false;

export function installPersonaHook(): () => void {
  if (registered) return () => {};
  registered = true;

  // Lazy: registry is loaded on the first incoming message rather than
  // forcing a synchronous load at startup. ensureLoaded inside the
  // resolver handles this.
  getPersonaRegistry().ensureLoaded().catch(err => {
    coreLogger.error({ err }, 'persona registry initial load failed');
  });

  // Live narration on swarm spawn/complete events. Bridge is itself
  // idempotent.
  installNarrationBridge();

  const off = getAgentHooks().register('before-agent-start', async (ctx) => {
    if (!ctx.root) return;

    const persona = await resolvePersonaForUser(ctx.userId);
    ctx.systemPrompt = insertPersonaBlock(ctx.systemPrompt, persona.promptBlock);
  });

  return () => {
    off();
    registered = false;
  };
}

/**
 * Where the hook puts a persona block: AFTER SECURITY_PREAMBLE so the security
 * rules remain the first thing the model reads. If the prompt doesn't start
 * with the preamble (e.g. a unit test that swapped the prompt), the persona
 * block is prepended whole.
 */
export function insertPersonaBlock(systemPrompt: string, personaBlock: string): string {
  if (systemPrompt.startsWith(SECURITY_PREAMBLE)) {
    return SECURITY_PREAMBLE + personaBlock + systemPrompt.slice(SECURITY_PREAMBLE.length);
  }
  return personaBlock + systemPrompt;
}

/** Test helper — reset the registration guard so tests can install fresh. */
export function _resetPersonaHookForTesting(): void {
  registered = false;
}

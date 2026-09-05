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
 * SECURITY_PREAMBLE and BEFORE the role prompt. Layer order:
 *
 *   SECURITY_PREAMBLE  (untouched — DESIGN.md rule #6)
 *   PERSONA            (this module — name, tone, voice rules, user facts)
 *   ROLE PROMPT        (the root role's prompt.md, untouched)
 *   (memory, session summary, etc. — appended downstream)
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
    const personaBlock = persona.promptBlock;

    // Insert AFTER SECURITY_PREAMBLE so the security rules remain the
    // first thing the model reads. If the prompt doesn't start with
    // the preamble (e.g. a unit test that swapped the prompt), prepend
    // the persona block whole.
    if (ctx.systemPrompt.startsWith(SECURITY_PREAMBLE)) {
      const after = ctx.systemPrompt.slice(SECURITY_PREAMBLE.length);
      ctx.systemPrompt = SECURITY_PREAMBLE + personaBlock + after;
    } else {
      ctx.systemPrompt = personaBlock + ctx.systemPrompt;
    }
  });

  return () => {
    off();
    registered = false;
  };
}

/** Test helper — reset the registration guard so tests can install fresh. */
export function _resetPersonaHookForTesting(): void {
  registered = false;
}

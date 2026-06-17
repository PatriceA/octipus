import { getResponseCache } from '@/core/response-cache';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { buildSecurityReminder } from './input-guard';
import type { ModelSelector } from './model-selector';
import { SECURITY_PREAMBLE } from './roles';
import { appendSources, type ResponseMetadata } from './types';
import { formatDateTimeContext } from '@/utils/date-context';

/**
 * Generate a direct LLM response for casual messages (no orchestrator/worker needed).
 */
export async function directResponse(
  message: string,
  sessionId: string,
  userId: string,
  modelSelector: ModelSelector,
  complexity: 'simple' | 'moderate' | 'complex' = 'moderate',
  guardFlags: string[] = [],
  /**
   * Memory-redesign Phase D — additional system-prompt context resolved
   * upstream (typically the rendered long-term memory block from
   * `renderMemoriesBlock`). Appended verbatim to the system content
   * after the base prompt; empty string = no-op.
   */
  extraSystemContext: string = '',
): Promise<{ response: string; metadata: ResponseMetadata }> {
  const startTime = Date.now();
  const client = getLiteLLMClient();
  const modelName = await modelSelector.selectByComplexity(complexity);

  await messageRepository.create({ sessionId, role: 'user', content: message });
  await sessionRepository.incrementMessageCount(sessionId);

  // Check response cache
  const cache = getResponseCache();
  const sessionForBoundary = await sessionRepository.findById(sessionId);
  const clearedAt = (sessionForBoundary?.context as SessionContext)?.clearedAt
    ? new Date((sessionForBoundary!.context as SessionContext).clearedAt!)
    : undefined;
  const recentMessages = await messageRepository.findRecentBySession(sessionId, 6, ['user', 'assistant'], clearedAt);
  const recentContext = recentMessages.slice(0, 2).map(m => m.content).join('|');

  const cached = await cache.get(sessionId, message, recentContext);
  if (cached) {
    await messageRepository.create({ sessionId, role: 'assistant', content: cached.response });
    await sessionRepository.incrementMessageCount(sessionId);
    return {
      response: cached.response,
      metadata: {
        model: cached.model,
        tokens: cached.tokens,
        latencyMs: Date.now() - startTime,
        cached: true,
      },
    };
  }

  try {
    const historyMessages = recentMessages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
      timestamp: m.createdAt,
    }));

    const session = sessionForBoundary ?? await sessionRepository.findById(sessionId);
    // Read session summary from compaction_entries (newest row), with
    // a fallback to legacy `context.compactedSummary` for sessions
    // compacted before the dual-write removal.
    let summary: string | undefined;
    if (!clearedAt) {
      try {
        const { compactionEntryRepository } = await import('@/db/repositories/compaction-entry-repository');
        const latest = await compactionEntryRepository.findLatest(sessionId);
        summary = latest?.summary ?? (session?.context as SessionContext)?.compactedSummary;
      } catch {
        summary = (session?.context as SessionContext)?.compactedSummary;
      }
    }
    const dateContext = `\nCURRENT DATE/TIME: ${formatDateTimeContext(new Date())}`;
    // Persona block — resolved from the user's assistant profile (or
    // the base octipus persona if no profile exists yet). Casual
    // replies go through this path, so the dry octopus-machine voice
    // applies to greetings/small-talk too, not just orchestrator runs.
    // Falls back to a one-line static persona if the registry isn't
    // initialized (early-boot test path).
    const sessionCtx = (sessionForBoundary?.context as SessionContext) || {};
    let personaBlock = '';
    try {
      const { resolvePersonaForUser } = await import('@/core/personas/resolver');
      const resolved = await resolvePersonaForUser(userId);
      personaBlock = resolved.promptBlock;
    } catch (err) {
      coreLogger.debug({ err }, 'direct-response: persona resolver unavailable, using static fallback');
      personaBlock =
        'You are Octipus, an octopus-machine. Refer to yourself in the third ' +
        'person ("Octipus is here") and use "we" for the collective. Short, ' +
        'direct, dry. Never "I". For casual chat, keep replies brief.';
    }
    // Dev-mode hint stays — orchestrator dispatch logic isn't on this
    // path but a casual reply in a coding workspace should at least
    // acknowledge the context.
    const isDevSession = Boolean(sessionCtx.devMode || sessionCtx.projectPath);
    const devHint = isDevSession
      ? '\n\nNOTE: This session is pinned to a project workspace. Casual replies stay brief.'
      : '';
    let basePrompt = SECURITY_PREAMBLE + personaBlock + devHint + dateContext;
    if (guardFlags.length > 0) {
      basePrompt += buildSecurityReminder(guardFlags);
    }

    const sources: string[] = [];
    if (recentMessages.length > 0) {
      sources.push(`recent ${recentMessages.length} msg${recentMessages.length === 1 ? '' : 's'}`);
    }
    if (summary) sources.push('session summary');

    // Inject user profile context for personalized responses
    if (userId) {
      try {
        const { ProfileRepository } = await import('@/db/repositories/profile-repository');
        const profileRepo = new ProfileRepository();
        const userProfile = await profileRepo.findUserProfile(userId);
        if (userProfile && (userProfile.facts as import('@/db/schema/profiles').ProfileFact[])?.length > 0) {
          const facts = (userProfile.facts as import('@/db/schema/profiles').ProfileFact[]).map(f => `- ${f.key}: ${f.value}`).join('\n');
          basePrompt += `\n\nUSER CONTEXT:\nName: ${userProfile.name}\n${facts}`;
          sources.push(`profile(${userProfile.name}, ${(userProfile.facts as import('@/db/schema/profiles').ProfileFact[]).length} facts)`);
        } else if (userProfile) {
          basePrompt += `\n\nUSER CONTEXT:\nName: ${userProfile.name}`;
          sources.push(`profile(${userProfile.name})`);
        }
      } catch (err) { coreLogger.error({ err }, 'silent failure in direct-response'); }
    }

    const systemContent =
      (summary ? `${basePrompt}\n\nPrevious conversation summary:\n${summary}` : basePrompt) +
      extraSystemContext;

    const registry = getModelRegistry();
    const resolvedModel = await registry.getModelByModelId(modelName);
    const modelMeta = resolvedModel?.metadata as import('@/db/schema/models').ModelMetadata | null;

    // Casual replies should be short, but thinking models (Gemini 3, o1, etc.)
    // burn output tokens on internal reasoning before emitting text. Use the
    // model's configured default (capped at 4096 for casual chat) so
    // thinking-budget models can finish their reply.
    const casualCap = Math.min(resolvedModel?.defaultMaxTokens || 1024, 4096);

    const result = await client.complete({
      model: modelName,
      messages: [
        { role: 'system', content: systemContent, timestamp: new Date() },
        ...historyMessages,
      ],
      temperature: 0.7,
      maxTokens: casualCap,
      extraBody: modelMeta?.extraBody,
      userId,
    });

    const tokens = result.usage?.totalTokens || 0;

    const showSources = (session?.metadata as Record<string, unknown> | undefined)?.showSources !== false;
    const finalContent = showSources ? appendSources(result.content, sources) : result.content;

    await messageRepository.create({ sessionId, role: 'assistant', content: finalContent });
    await sessionRepository.incrementMessageCount(sessionId);

    await cache.set(sessionId, message, recentContext, {
      response: finalContent,
      model: modelName,
      tokens,
      cachedAt: Date.now(),
    });

    return {
      response: finalContent,
      metadata: {
        model: modelName,
        tokens,
        latencyMs: Date.now() - startTime,
        cached: false,
      },
    };
  } catch (err) {
    // Use the `err` key — Pino's Error serializer is keyed on that name.
    // Logging under any other key falls through to JSON.stringify, which
    // drops non-enumerable Error fields and produces a useless `{}`.
    // Also log message/stack/name explicitly so even a stripped-down log
    // formatter shows what actually went wrong.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const name = err instanceof Error ? err.name : 'Error';
    coreLogger.error(
      { err, message, stack, name, model: modelName },
      'Direct response failed',
    );
    const errorMsg = `Sorry, I'm having trouble connecting to the language model (${modelName}). Please check that the model provider is running and configured correctly.`;
    await messageRepository.create({ sessionId, role: 'assistant', content: errorMsg });
    await sessionRepository.incrementMessageCount(sessionId);
    return {
      response: errorMsg,
      metadata: { model: modelName, latencyMs: Date.now() - startTime },
    };
  }
}

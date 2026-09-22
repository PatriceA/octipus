import { readSessionHistory, withSessionConversation } from '@/core/session-history';
import { buildSelectedSkillPrompt } from '@/skills/selection';
import { VOLATILE_MARKER } from '@/models/providers/prompt-cache';
import { getResponseCache } from '@/core/response-cache';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { formatDateTimeContext } from '@/utils/date-context';
import { coreLogger } from '@/utils/logger';
import { buildSecurityReminder } from './input-guard';
import type { ModelSelector } from './model-selector';
import { SECURITY_PREAMBLE } from './roles';
import { appendSources, type ResponseMetadata } from './types';

/**
 * Assemble a direct-response system prompt from its components.
 * Exported for testing the prompt caching split.
 */
export function buildDirectResponseSystem(args: {
  persona: string;
  dateContext: string;
  summary?: string;
  devHint?: string;
  guardFlags?: string;
  userProfile?: string;
  extraSystemContext?: string;
}): string {
  const devHint = args.devHint ?? '';
  let basePrompt = SECURITY_PREAMBLE + args.persona + devHint + '\n\n' + args.dateContext;
  if (args.guardFlags) {
    basePrompt += args.guardFlags;
  }
  if (args.userProfile) {
    basePrompt += args.userProfile;
  }
  const summary = args.summary;
  const extraSystemContext = args.extraSystemContext ?? '';
  return (summary ? `${basePrompt}\n\nPrevious conversation summary:\n${summary}` : basePrompt) + extraSystemContext;
}

/**
 * Generate a direct LLM response for casual messages (no root agent/worker needed).
 */
async function directResponseInternal(
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
  /**
   * Skip complexity-based routing and use this exact model. The voice plan gate
   * passes the fast `voice`-topic model here so spoken planning turns stay snappy.
   */
  modelOverride?: string,
): Promise<{ response: string; metadata: ResponseMetadata }> {
  const startTime = Date.now();
  const client = getLiteLLMClient();
  const modelName = modelOverride || (await modelSelector.selectByComplexity(complexity));

  const history = await readSessionHistory(sessionId);
  const sessionForBoundary = history.session;
  const session = history.session;
  const selectedSkills = await buildSelectedSkillPrompt(userId, sessionId);
  const cache = getResponseCache();
  const recentMessages = history.rows;
  const historyMessages = history.messages;
  const summary = history.checkpoint?.summary;
  const persistAnswer = async (content: string) => {
    const row = await messageRepository.createForGeneration({ sessionId, role: 'assistant', content }, history.generation);
    if (!row) return false;
    await sessionRepository.incrementMessageCount(sessionId);
    return true;
  };
  try {
    const dateContext = `CURRENT DATE/TIME: ${formatDateTimeContext(new Date())}`;
    // Persona block — resolved from the user's assistant profile (or
    // the base octipus persona if no profile exists yet). Casual
    // replies go through this path, so the dry octopus-machine voice
    // applies to greetings/small-talk too, not just root agent runs.
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
    // Dev-mode hint stays — root agent dispatch logic isn't on this
    // path but a casual reply in a coding workspace should at least
    // acknowledge the context.
    const isDevSession = Boolean(sessionCtx.devMode || sessionCtx.projectPath);
    const devHint = isDevSession
      ? '\n\nNOTE: This session is pinned to a project workspace. Casual replies stay brief.'
      : '';
    const guardFlagsStr = guardFlags.length > 0 ? buildSecurityReminder(guardFlags) : '';

    const sources: string[] = [];
    if (recentMessages.length > 0) {
      sources.push(`recent ${recentMessages.length} msg${recentMessages.length === 1 ? '' : 's'}`);
    }
    if (summary) sources.push('session summary');

    // Inject user profile context for personalized responses
    let userProfileStr = '';
    if (userId) {
      try {
        const { ProfileRepository } = await import('@/db/repositories/profile-repository');
        const profileRepo = new ProfileRepository();
        const userProfile = await profileRepo.findUserProfile(userId);
        if (userProfile && (userProfile.facts as import('@/db/schema/profiles').ProfileFact[])?.length > 0) {
          const facts = (userProfile.facts as import('@/db/schema/profiles').ProfileFact[]).map(f => `- ${f.key}: ${f.value}`).join('\n');
          userProfileStr = `\n\nUSER CONTEXT:\nName: ${userProfile.name}\n${facts}`;
          sources.push(`profile(${userProfile.name}, ${(userProfile.facts as import('@/db/schema/profiles').ProfileFact[]).length} facts)`);
        } else if (userProfile) {
          userProfileStr = `\n\nUSER CONTEXT:\nName: ${userProfile.name}`;
          sources.push(`profile(${userProfile.name})`);
        }
      } catch (err) { coreLogger.error({ err }, 'silent failure in direct-response'); }
    }

    const systemContent = buildDirectResponseSystem({
      persona: personaBlock + selectedSkills,
      dateContext: dateContext,

      devHint: devHint,
      guardFlags: guardFlagsStr,
      userProfile: userProfileStr,
      extraSystemContext: extraSystemContext,
    });

    const boundary = systemContent.match(VOLATILE_MARKER)?.index ?? systemContent.length;
    const stableSystem = systemContent.slice(0, boundary);
    const promptContext = systemContent.slice(boundary).trim();
    const userRow = await messageRepository.createForGeneration({ sessionId, role: 'user', content: message,
      metadata: { promptContext } }, history.generation);
    if (!userRow) return { response: 'Conversation was cleared while this turn was running.', metadata: { model: modelName } };
    await sessionRepository.incrementMessageCount(sessionId);
    historyMessages.push({ role: 'user', content: [promptContext, message].filter(Boolean).join('\n\n'), timestamp: userRow.createdAt });
    // Response reuse requires the whole effective context, model and clear generation.
    const recentContext = JSON.stringify([history.generation, modelName, stableSystem, historyMessages.map(m => [m.role, m.content])]);
    const cached = await cache.get(sessionId, message, recentContext);
    if (cached && await persistAnswer(cached.response)) return { response: cached.response,
      metadata: { model: cached.model, tokens: 0, latencyMs: Date.now() - startTime, cached: true } };

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
      modelConfigName: resolvedModel?.name,
      messages: [
        { role: 'system', content: stableSystem, timestamp: new Date() },
        ...historyMessages,
      ],
      temperature: 0.7,
      maxTokens: casualCap,
      extraBody: modelMeta?.extraBody,
      userId,
      sessionId,
      cacheScope: `root:${history.generation}`,
    });

    const tokens = result.usage?.totalTokens || 0;

    const showSources = (session?.metadata as Record<string, unknown> | undefined)?.showSources !== false;
    const finalContent = showSources ? appendSources(result.content, sources) : result.content;

    if (!await persistAnswer(finalContent)) return { response: 'Conversation was cleared while this turn was running.', metadata: { model: modelName, tokens } };

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
    await persistAnswer(errorMsg);
    return {
      response: errorMsg,
      metadata: { model: modelName, latencyMs: Date.now() - startTime },
    };
  }
}

/** Casual turns share the same serialization boundary as root workers and compaction. */
export function directResponse(...args: Parameters<typeof directResponseInternal>): ReturnType<typeof directResponseInternal> {
  return withSessionConversation(args[1], () => directResponseInternal(...args));
}

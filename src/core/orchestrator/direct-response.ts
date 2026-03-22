import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { sessionRepository } from '@/db/repositories/session-repository';
import { messageRepository } from '@/db/repositories/message-repository';
import { getResponseCache } from '@/core/response-cache';
import { coreLogger } from '@/utils/logger';
import { SECURITY_PREAMBLE } from './roles';
import { buildSecurityReminder } from './input-guard';
import type { ModelSelector } from './model-selector';
import type { ResponseMetadata } from './types';
import type { SessionContext } from '@/db/schema/sessions';

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
): Promise<{ response: string; metadata: ResponseMetadata }> {
  const startTime = Date.now();
  const client = getLiteLLMClient();
  const modelName = await modelSelector.selectByComplexity(complexity);

  await messageRepository.create({ sessionId, role: 'user', content: message });
  await sessionRepository.incrementMessageCount(sessionId);

  // Check response cache
  const cache = getResponseCache();
  const recentMessages = await messageRepository.findRecentBySession(sessionId, 6, ['user', 'assistant']);
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

    const session = await sessionRepository.findById(sessionId);
    const summary = (session?.context as SessionContext)?.compactedSummary;
    const now = new Date();
    const dateContext = `\nCURRENT DATE/TIME: ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
    let basePrompt = SECURITY_PREAMBLE + 'You are a friendly development assistant. Keep casual responses brief and helpful.' + dateContext;
    if (guardFlags.length > 0) {
      basePrompt += buildSecurityReminder(guardFlags);
    }
    const systemContent = summary
      ? `${basePrompt}\n\nPrevious conversation summary:\n${summary}`
      : basePrompt;

    const registry = getModelRegistry();
    const resolvedModel = await registry.getModelByModelId(modelName);
    const modelMeta = resolvedModel?.metadata as import('@/db/schema/models').ModelMetadata | null;

    const result = await client.complete({
      model: modelName,
      messages: [
        { role: 'system', content: systemContent, timestamp: new Date() },
        ...historyMessages,
      ],
      temperature: 0.7,
      maxTokens: 512,
      extraBody: modelMeta?.extraBody,
    });

    const tokens = result.usage?.totalTokens || 0;

    await messageRepository.create({ sessionId, role: 'assistant', content: result.content });
    await sessionRepository.incrementMessageCount(sessionId);

    await cache.set(sessionId, message, recentContext, {
      response: result.content,
      model: modelName,
      tokens,
      cachedAt: Date.now(),
    });

    return {
      response: result.content,
      metadata: {
        model: modelName,
        tokens,
        latencyMs: Date.now() - startTime,
        cached: false,
      },
    };
  } catch (error) {
    coreLogger.error({ error, model: modelName }, 'Direct response failed');
    const errorMsg = `Sorry, I'm having trouble connecting to the language model (${modelName}). Please check that the model provider is running and configured correctly.`;
    await messageRepository.create({ sessionId, role: 'assistant', content: errorMsg });
    await sessionRepository.incrementMessageCount(sessionId);
    return {
      response: errorMsg,
      metadata: { model: modelName, latencyMs: Date.now() - startTime },
    };
  }
}

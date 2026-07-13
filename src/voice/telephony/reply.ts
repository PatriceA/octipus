/**
 * Phone reply generation (Phase 4d).
 *
 * The media-stream handler needs a transcript → short spoken reply, the same
 * "fast path" the Gather webhook uses (direct LLM with a voice/expert prompt, no
 * orchestrator, for latency). Factored out here so the streaming path reuses it.
 *
 * ponytail: the webhook fast path in routes/voice.ts still inlines an equivalent
 * block; converge it onto this helper in a follow-up (left untouched now to keep
 * the telephony-streaming change from touching the working Gather path).
 */
import { apiLogger } from '../../utils/logger';

export interface PhoneTurn {
  role: 'user' | 'assistant';
  content: string;
}

const DEFAULT_VOICE_PROMPT =
  'You are a helpful voice assistant on a phone call. Keep responses short (1-3 sentences), natural, and conversational. No markdown, no lists, no code blocks.';
const PHONE_STYLE =
  '\n\nIMPORTANT: You are on a live phone call. Keep responses short (1-3 sentences), natural, conversational. No markdown, no lists, no code.';
const END_CALL_INSTRUCTION =
  '\n\nWhen the caller says goodbye or clearly wants to hang up, respond with a brief farewell and end with the exact marker [END_CALL].';

/**
 * The phone system prompt: the configured 'communication' expert (same persona
 * the Gather webhook uses) + phone-style + end-call marker, falling back to a
 * generic voice assistant. Cached per process — the expert rarely changes.
 */
let cachedExpertPrompt: string | null | undefined; // undefined = not looked up yet
async function resolvePhonePrompt(): Promise<string> {
  if (cachedExpertPrompt === undefined) {
    cachedExpertPrompt = null;
    try {
      const { getDb } = await import('../../db/postgres');
      const { experts } = await import('../../db/schema/experts');
      const { eq } = await import('drizzle-orm');
      const [expert] = await getDb().select().from(experts).where(eq(experts.role, 'communication')).limit(1);
      if (expert?.systemPrompt) cachedExpertPrompt = expert.systemPrompt;
    } catch {
      /* fall back to default */
    }
  }
  return (cachedExpertPrompt || DEFAULT_VOICE_PROMPT) + PHONE_STYLE + END_CALL_INSTRUCTION;
}

/** Generate a short spoken reply for a phone turn. Mutates `history` in place. */
export async function generatePhoneReply(
  transcript: string,
  history: PhoneTurn[],
): Promise<{ text: string; endCall: boolean }> {
  const { getLiteLLMClient } = await import('../../models/litellm-client');
  const { getModelRegistry } = await import('../../models/model-registry');
  const client = getLiteLLMClient();
  const registry = getModelRegistry();

  let modelId: string | undefined;
  try {
    const { ModelSelector } = await import('../../core/orchestrator/model-selector');
    modelId = (await new ModelSelector().selectForWorker('voice', false)).model;
  } catch {
    /* fall through to default */
  }
  modelId ||= (await registry.getDefaultModel())?.modelId;
  if (!modelId) throw new Error('No model configured for voice topic');

  history.push({ role: 'user', content: transcript });

  const { applyTopicParamOverrides, getTopicConfig } = await import('../../models/topic-config');
  const params = applyTopicParamOverrides({ temperature: 0.7, maxTokens: 256 }, getTopicConfig('voice'));

  const started = Date.now();
  const result = await client.complete({
    model: modelId,
    messages: [
      { role: 'system', content: await resolvePhonePrompt(), timestamp: new Date() },
      ...history.map((m) => ({ role: m.role, content: m.content, timestamp: new Date() })),
    ],
    ...params,
  });

  let text = (result.content || "I didn't catch that.").trim();
  const endCall = text.includes('[END_CALL]');
  text = text.replace(/\[END_CALL\]/g, '').trim();
  history.push({ role: 'assistant', content: text });
  if (history.length > 40) history.splice(0, history.length - 40);

  apiLogger.info({ latencyMs: Date.now() - started, model: modelId, endCall }, 'phone reply generated');
  return { text, endCall };
}

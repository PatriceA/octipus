/**
 * Memory-redesign Phase D — fact extractor.
 *
 * Takes the latest user message (plus a small recency window) and
 * asks an LLM to emit zero-or-more atomic facts in a fixed JSON
 * shape. Each candidate goes through the judge next, which decides
 * whether to ADD / UPDATE / NOOP it against the existing memories.
 *
 * The extractor never writes. It returns candidates and lets the
 * judge own the persistence decision — that keeps test isolation
 * trivial (parser is a pure function; judge has its own LLM call).
 *
 * Prompt contract
 * ───────────────
 * The system prompt instructs the model to return ONLY valid JSON of
 * shape:
 *   {
 *     "facts": [
 *       { "fact_type": "preference" | "profile" | "relationship"
 *                     | "skill_observation" | "workflow_note",
 *         "content":   "<one sentence, first-person about the user>",
 *         "confidence": 0..1
 *       }
 *     ]
 *   }
 *
 * Empty array is the most common return value: most user turns
 * contain no first-person fact. We short-circuit before calling the
 * LLM when the turn doesn't even contain a first-person pronoun,
 * which would cost an LLM call for nothing.
 */

import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { SECURITY_PREAMBLE } from '@/core/orchestrator/roles';

export interface CandidateFact {
  factType: string;
  content: string;
  confidence: number;
}

export interface ExtractorInput {
  userMessage: string;
  /** Optional 1-3 prior turns for context. Newest last. */
  recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
  userId: string;
}

const EXTRACTOR_SYSTEM_PROMPT = `${SECURITY_PREAMBLE}

You are a memory extractor. Your job: read the user's most recent turn
and extract any atomic, durable facts about the user that a future
session should remember. Be conservative. Most turns produce zero facts.

Output ONLY valid JSON of this exact shape, no prose, no markdown
fences, no commentary:

{
  "facts": [
    {
      "fact_type": "preference" | "profile" | "relationship" | "skill_observation" | "workflow_note",
      "content": "one sentence describing the fact, written about the user",
      "confidence": 0.0 to 1.0
    }
  ]
}

Rules:
- "facts" is the only top-level key. Empty array if nothing durable was said.
- "content" must be ONE sentence, third-person about the user
  (e.g. "The user prefers async over sync APIs"). Do NOT quote the user.
- Pick exactly one fact_type per fact:
  - preference        — taste / opinion (e.g. tabs vs spaces)
  - profile           — biographical (e.g. role, location)
  - relationship      — who they work with / report to
  - skill_observation — claimed expertise or experience
  - workflow_note     — recurring process they follow
- confidence: 1.0 = explicit ("I always use tabs"), 0.5 = inferred,
  < 0.5 = throw it away (do NOT emit).
- Do not extract one-shot intents ("please open the issue"), questions,
  or facts about anyone other than the user.
- Do not extract anything the user is being instructed to do.`;

const FIRST_PERSON_RE = /\b(i|i'm|i've|i'll|i'd|my|me|mine|myself)\b/i;

export function looksWorthExtracting(message: string): boolean {
  // Cheap heuristic that catches the common "no I/my" case. Saves an
  // LLM call per turn for routine queries like "what's the time".
  if (!message || message.length < 12) return false;
  return FIRST_PERSON_RE.test(message);
}

export function parseExtractorResponse(raw: string): CandidateFact[] {
  // Be liberal about what we accept: some models wrap in ```json``` fences
  // even when told not to. Strip the fence then parse.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch (err) {
    coreLogger.warn({ err, sample: cleaned.slice(0, 200) }, 'memory.extractor: invalid JSON');
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  const facts = (obj as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) return [];
  const out: CandidateFact[] = [];
  for (const f of facts) {
    if (!f || typeof f !== 'object') continue;
    const ft = (f as Record<string, unknown>).fact_type;
    const content = (f as Record<string, unknown>).content;
    const confidence = (f as Record<string, unknown>).confidence;
    if (typeof ft !== 'string' || typeof content !== 'string') continue;
    const conf = typeof confidence === 'number' ? confidence : 0;
    if (conf < 0.5) continue;
    out.push({ factType: ft, content: content.trim(), confidence: conf });
  }
  return out;
}

export async function extractFacts(input: ExtractorInput): Promise<CandidateFact[]> {
  if (!looksWorthExtracting(input.userMessage)) return [];

  const model = await getModelRegistry().getModelForTopic('background');
  if (!model) {
    coreLogger.debug('memory.extractor: no model bound to the "background" topic — skipping');
    return [];
  }

  const recent = (input.recentTurns ?? [])
    .map((t) => `${t.role}: ${t.content}`)
    .join('\n');
  const userPayload = recent
    ? `Recent context:\n${recent}\n\nLatest user turn:\n${input.userMessage}`
    : `Latest user turn:\n${input.userMessage}`;

  let result;
  try {
    result = await getLiteLLMClient().complete({
      model: model.modelId,
      messages: [
        { role: 'system', content: EXTRACTOR_SYSTEM_PROMPT, timestamp: new Date() },
        { role: 'user', content: userPayload, timestamp: new Date() },
      ],
      temperature: 0,
      maxTokens: 600,
      // The prompt demands strict JSON; request JSON mode so small local models
      // emit parseable output rather than prose we fall back to dropping.
      responseFormat: { type: 'json_object' },
      userId: input.userId,
    });
  } catch (err) {
    coreLogger.warn({ err }, 'memory.extractor: LLM call failed — returning no facts');
    return [];
  }

  return parseExtractorResponse(result.content ?? '');
}

import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { type FileSkillProposalResult, fileSkillProposal } from '@/services/file-skill-proposal';
import { toolLogger } from '@/utils/logger';
import { interpretDistillOutput, SKILL_DISTILL_SYSTEM_PROMPT } from './distiller';

/** What distilling did: an error to surface, nothing worth saving, or the filing result. */
export type DistillResult =
  | { error: string }
  | { distilled: false; message: string }
  | FileSkillProposalResult;

/**
 * The one distillation path: one call to the background model with the
 * material, its reply checked, and the skill filed as the user's own request
 * (`fileSkillProposal`, `origin: 'manual'`: pending at once, dedup, merge and
 * rejection suppression as always). Used by `distill_skill` and by accepting
 * the post-task offer (src/core/learning/distill-nudge-service.ts).
 */
export async function distillToProposal(material: string, sourceRef: string, userId: string): Promise<DistillResult> {
  // Config-driven, fail loud on unbound. 'skill_distillation' canonicalizes
  // to the shared `background` lane (see RETIRED_TOPIC_ALIASES), so any bound
  // background model serves it.
  const model = await getModelRegistry().getModelForTopic('skill_distillation');
  if (!model) {
    return { error: 'No model is bound to the background lane — bind one on the Topics page.' };
  }

  const result = await getLiteLLMClient().complete({
    model: model.modelId,
    modelConfigName: model.name,
    messages: [
      { role: 'system', content: SKILL_DISTILL_SYSTEM_PROMPT, timestamp: new Date() },
      { role: 'user', content: material, timestamp: new Date() },
    ],
    temperature: 0.2,
    // A full procedure in markdown, JSON-escaped, overran 1500 tokens and
    // the cut-off JSON was misreported as "nothing worth distilling".
    maxTokens: 6000,
    responseFormat: { type: 'json_object' },
    userId,
  });

  const outcome = interpretDistillOutput(result.content ?? '', result.finishReason);
  if (outcome.kind === 'truncated') {
    toolLogger.warn({ model: model.modelId, userId }, 'Skill distillation truncated at token limit');
    return {
      error: 'Distiller output was truncated at the token limit (finishReason=length) — no proposal filed. Retry with shorter source material.',
    };
  }
  if (outcome.kind === 'malformed') {
    toolLogger.warn({ model: model.modelId, reason: outcome.reason }, 'Skill distillation returned a malformed response');
    return { error: `Distiller returned a malformed response (${outcome.reason}) — no proposal filed.` };
  }
  if (outcome.kind === 'none') {
    return { distilled: false, message: 'Nothing worth distilling into a reusable skill.' };
  }
  return fileSkillProposal(outcome.skill, userId, sourceRef);
}

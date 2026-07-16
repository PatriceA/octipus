import { and, eq } from 'drizzle-orm';
import type { ToolManifest } from '@/core/types';
import { getDb } from '@/db/postgres';
import { messageRepository } from '@/db/repositories/message-repository';
import { skillProposals } from '@/db/schema/skill-proposals';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { toolLogger } from '@/utils/logger';
import { BaseTool, createParameterSchema } from '../base-tool';
import { parseDistilledSkill, skillFingerprint, SKILL_DISTILL_SYSTEM_PROMPT } from './distiller';

/**
 * skill-distill — the generative half of the learning loop (Hermes A1). Distils
 * a REUSABLE skill from recent conversation or provided text and files it as a
 * *pending* skill proposal (kind='skill') for human review. It never creates a
 * live skill directly: promotion happens through the existing
 * `POST /skills/proposals/:id/approve` path, keeping the permission model
 * intact. Complements the curator's pruning half (`src/skills/curator.ts`).
 */
export class SkillDistillTool extends BaseTool {
  readonly id = 'skill-distill';
  readonly name = 'Skill Distill';
  readonly version = '1.0.0';
  readonly description =
    'Distil a reusable skill from recent conversation or provided text and file it as a pending skill proposal for review.';

  getManifest(): ToolManifest {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      description: this.description,
      permissions: [
        { action: 'distill', description: 'Distil and propose a new skill', defaultLevel: 'ALLOW' },
      ],
      tools: [
        {
          name: 'distill_skill',
          description:
            'Distil a reusable skill from recent conversation or provided text; files a pending skill proposal for review (does NOT create a live skill).',
          parameters: {
            source: { type: 'string', description: "'conversation' (recent turns) or 'text'", required: true },
            content: { type: 'string', description: "Source text when source='text'" },
          },
          returns: 'The created (or existing pending) skill proposal',
        },
      ],
    };
  }

  protected async registerTools(): Promise<void> {
    this.registerTool(
      'distill_skill',
      "Distil a reusable skill from recent conversation (source='conversation') or provided text " +
        "(source='text' with `content`). Files a PENDING skill proposal for human review — it does not " +
        'create a live skill. Returns the proposal, or a no-op when there is nothing worth saving.',
      createParameterSchema({
        source: {
          type: 'string',
          description: "Where to distil from: 'conversation' (recent session turns) or 'text'",
          required: true,
        },
        content: { type: 'string', description: "The source text when source='text'" },
      }),
      async (args, context) => {
        const source = String(args.source ?? 'conversation');

        // 1. Gather the source material.
        let material: string;
        if (source === 'text') {
          material = String(args.content ?? '').trim();
          if (!material) return { error: "source='text' requires a non-empty `content`" };
        } else {
          const msgs = await messageRepository.findRecentBySession(context.sessionId, 30, ['user', 'assistant']);
          material = msgs.map((m) => `${m.role}: ${m.content}`).join('\n\n').trim();
          if (!material) return { error: 'No recent conversation to distil from' };
        }

        // 2. Resolve the distiller model — config-driven, fail loud on unbound.
        // 'skill_distillation' canonicalizes to the shared `background` lane
        // (see RETIRED_TOPIC_ALIASES), so any bound background model serves it.
        const model = await getModelRegistry().getModelForTopic('skill_distillation');
        if (!model) {
          return {
            error: 'No model is bound to the background lane — bind one on the Topics page.',
          };
        }

        // 3. Distil.
        const result = await getLiteLLMClient().complete({
          model: model.modelId,
          messages: [
            { role: 'system', content: SKILL_DISTILL_SYSTEM_PROMPT, timestamp: new Date() },
            { role: 'user', content: material, timestamp: new Date() },
          ],
          temperature: 0.2,
          maxTokens: 1500,
          responseFormat: { type: 'json_object' },
          userId: context.userId,
        });

        const distilled = parseDistilledSkill(result.content ?? '');
        if (!distilled) {
          return { distilled: false, message: 'Nothing worth distilling into a reusable skill.' };
        }

        // 4. Dedup: if an identical pending proposal already exists, return it
        //    rather than spawning a duplicate (proposal-spam guard).
        const db = getDb();
        const fingerprint = skillFingerprint(context.userId, distilled.name);
        const [existing] = await db
          .select()
          .from(skillProposals)
          .where(and(eq(skillProposals.fingerprint, fingerprint), eq(skillProposals.status, 'pending')))
          .limit(1);
        if (existing) {
          return {
            distilled: true,
            proposalId: existing.id,
            name: existing.name,
            deduped: true,
            status: 'pending',
            note: 'An identical pending skill proposal already exists.',
          };
        }

        // 5. File the proposal (pending review). kind='skill' routes the approve
        //    path to create a skill, not an expert.
        const [proposal] = await db
          .insert(skillProposals)
          .values({
            userId: context.userId,
            fingerprint,
            name: distilled.name,
            description: distilled.description,
            draftPromptTemplate: distilled.content,
            kind: 'skill',
            sourceRef: source === 'text' ? 'text' : `session:${context.sessionId}`,
            lastExemplarAt: new Date(),
          })
          .returning();

        toolLogger.info(
          { proposalId: proposal?.id, name: distilled.name, userId: context.userId },
          'Distilled a skill proposal',
        );
        return {
          distilled: true,
          proposalId: proposal?.id,
          name: distilled.name,
          description: distilled.description,
          status: 'pending',
          note: 'Filed as a pending skill proposal for review (not yet a live skill).',
        };
      },
      { requiresPermission: false },
    );
  }
}

/** Auto-discovered singleton (see src/tools/discovery.ts). */
export const skillDistillTool = new SkillDistillTool();

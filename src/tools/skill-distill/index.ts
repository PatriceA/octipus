import { isSharedWorkspace } from '@/core/spaces/service';
import type { AgentContext, ToolManifest } from '@/core/types';
import { messageRepository } from '@/db/repositories/message-repository';
import { scopedRepos } from '@/db/repositories/scoped';
import { sessionRepository } from '@/db/repositories/session-repository';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import { agentPrincipal } from '@/security/principal';
import { BaseTool, createParameterSchema } from '../base-tool';
import { distillToProposal } from './distill';
import { readTrajectoryRecordLine, trajectoryToDistillMaterial } from './trajectory-source';

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
            source: { type: 'string', description: "'conversation' (recent turns), 'text', or 'trajectory'", required: true },
            content: { type: 'string', description: "Source text when source='text'" },
            ref: { type: 'string', description: "Trajectory run id when source='trajectory'" },
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
          description: "Where to distil from: 'conversation' (recent session turns), 'text', or 'trajectory'",
          required: true,
        },
        content: { type: 'string', description: "The source text when source='text'" },
        ref: { type: 'string', description: "A trajectory run id when source='trajectory'" },
      }),
      async (args, context) => {
        const source = String(args.source ?? 'conversation');

        // 1. Gather the source material + its provenance.
        let material: string;
        let sourceRef: string;
        if (source === 'text') {
          material = String(args.content ?? '').trim();
          if (!material) return { error: "source='text' requires a non-empty `content`" };
          sourceRef = 'text';
        } else if (source === 'trajectory') {
          const gathered = await this.gatherTrajectory(String(args.ref ?? '').trim(), context);
          if ('error' in gathered) return gathered.error;
          material = gathered.material;
          sourceRef = gathered.sourceRef;
        } else {
          const msgs = await messageRepository.findRecentBySession(context.sessionId, 30, ['user', 'assistant']);
          material = msgs.map((m) => `${m.role}: ${m.content}`).join('\n\n').trim();
          if (!material) return { error: 'No recent conversation to distil from' };
          sourceRef = `session:${context.sessionId}`;
        }

        // 2. Distil with the background model and file the proposal.
        return distillToProposal(material, sourceRef, context.userId);
      },
      { permissionAction: 'distill' },
    );
  }

  /**
   * Gather + verify a trajectory run for distillation. Returns the material +
   * provenance, or an `error` carrying the tool result to return verbatim.
   * Only *verified-good* runs are distilled: outcome must be 'success', and if
   * the session recorded verification evidence (B1) none of it may have failed.
   */
  private async gatherTrajectory(
    ref: string,
    context: AgentContext,
  ): Promise<{ material: string; sourceRef: string } | { error: Record<string, unknown> }> {
    if (!ref) return { error: { error: "source='trajectory' requires `ref` (a trajectory run id)" } };
    // A proposal is personal: a space's runs never become one (I2, I9).
    if (context.space) {
      return { error: { error: "source='trajectory' is not available in a shared space: a skill proposal is personal" } };
    }

    // The caller's own runs of their personal scope only (`scopedRepos`): never
    // another user's, never a space's.
    const run = await scopedRepos(agentPrincipal(context)).trajectories.findById(ref);
    if (!run) return { error: { error: `Trajectory run ${ref} not found` } };
    // A run recorded before its workspace was stored has none: its root
    // session tells. A room or a space session is not personal material.
    const session = await sessionRepository.findById(run.rootSessionId);
    if (session && (session.kind === 'room' || (session.workspaceId && (await isSharedWorkspace(session.workspaceId))))) {
      return { error: { error: `Trajectory run ${ref} belongs to a shared space: it cannot be distilled into a personal skill` } };
    }

    if (run.outcome !== 'success') {
      return { error: { distilled: false, message: `Trajectory outcome is '${run.outcome}', not 'success' — skipped.` } };
    }

    // B1 verdict gate. No evidence ⇒ fall back to the outcome (graceful).
    const evidence = await verificationEvidenceRepository.listForSession(run.rootSessionId);
    if (evidence.length > 0 && !(await verificationEvidenceRepository.isSessionVerified(run.rootSessionId))) {
      return { error: { distilled: false, message: 'Trajectory session has failing verification evidence — skipped.' } };
    }

    const record = readTrajectoryRecordLine(run.jsonlPath, run.jsonlLine);
    if (!record) {
      return { error: { error: `Could not read trajectory record from ${run.jsonlPath}:${run.jsonlLine}` } };
    }
    const material = trajectoryToDistillMaterial(record);
    if (!material) return { error: { error: 'Trajectory record has no usable content' } };

    return { material, sourceRef: `trajectory:${ref}` };
  }
}

/** Auto-discovered singleton (see src/tools/discovery.ts). */
export const skillDistillTool = new SkillDistillTool();

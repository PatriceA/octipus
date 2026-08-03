import { desc, eq } from 'drizzle-orm';
import { getNotificationService } from '@/core/notification-service';
import type { AgentContext } from '@/core/types';
import { getDb } from '@/db/postgres';
import { messageRepository } from '@/db/repositories/message-repository';
import { pipelineRepository } from '@/db/repositories/pipeline-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { PipelineStepConfig } from '@/db/schema/pipeline-templates';
import { pipelineTemplates } from '@/db/schema/pipeline-templates';
import type { NewPipeline, NewPipelineStage, Pipeline, PipelineStageRow } from '@/db/schema/pipelines';
import { pipelineStages, pipelines } from '@/db/schema/pipelines';
import { getModelRegistry, type ModelRegistry } from '@/models/model-registry';
import { coreLogger } from '@/utils/logger';
import { createHandoffContext, formatHandoffChain, HANDOFF_EMIT_INSTRUCTION, stripHandoffBlock, type HandoffContext } from './handoff';

/**
 * Coerce an arbitrary value to the enumerated QA confidence (or undefined).
 *
 * Case- and whitespace-insensitive: a model writing `"High"` has stated its
 * confidence, and since the thin-verdict rule now REJECTS a pass with no
 * usable confidence, exact-literal matching would fail an accountable audit
 * over capitalisation.
 */
function normalizeConfidence(v: unknown): QAValidationResult['confidence'] {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return s === 'high' || s === 'medium' || s === 'low' ? s : undefined;
}
/**
 * Coerce a JSON field to a list of non-empty strings. A model that answers
 * `"nothing"` instead of `["nothing"]` is answering the question, so a bare
 * string is accepted; anything else yields an empty list, which the
 * thin-verdict rule treats as "did not state it".
 */
function normalizeStringList(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean);
}
/** Pull a stated `confidence: high|medium|low` (JSON or prose) from raw text. */
function parseConfidence(text: string): QAValidationResult['confidence'] {
  const m = text.match(/confidence["\s]*[:=]\s*["']?(high|medium|low)/i);
  return m ? (m[1].toLowerCase() as 'high' | 'medium' | 'low') : undefined;
}

/**
 * Appended to `qa_validation` stages so they emit a machine-readable verdict
 * `parseQAResult`'s strict-JSON tier (1) consumes — instead of relying on the
 * prose-verdict fallback (`parseProseVerdict`, tier 3) to recover PASS/FAIL from
 * free text (Phase B2). Kept as a runtime injection (both run loops) so it
 * reaches ad-hoc pipelines and existing installs, not only reseeded templates.
 *
 * Describes the shape as a field list with NO literal ```json fence: if this
 * text is echoed, `parseQAResult`'s first-fence match would otherwise grab the
 * placeholder instead of the model's real verdict (the B3 anti-echo lesson).
 * `parseProseVerdict` stays as the loud fallback until eval proves the JSON path
 * fires on 100% of QA stages — its deletion is deferred (follow-ups plan B2).
 */
export const QA_VERDICT_JSON_INSTRUCTION = `

---
QA VERDICT (required) — after your report above, append your verdict as a fenced code block tagged \`json\` (open the fence with three backticks then the word json) containing ONLY an object with these fields and YOUR real values:
- passed (boolean): true only if the implementation is acceptable; false if ANY critical or major issue remains
- confidence ("high" | "medium" | "low"): your confidence in this verdict. An honest "low" is welcome — it routes follow-up work rather than counting against you
- issues (string[]): each blocking issue as one short string ([] when none)
- feedback (string): a one-paragraph, actionable summary for the retry. To pass, this must NAME each stage you audited and what you checked about it — a pass that does not account for the work it covers is rejected and re-run
- whatIDidNotCheck (string[]): what you did NOT verify, one short string each. Never empty on a pass: write ["nothing — the change is trivial"] if you truly covered everything

Emit the block exactly once — do not copy these field descriptions.`;
import { paramTemplateVars, resolveRecipeParams } from './recipe-params';
import { getOrchestratorService } from './service';
import { buildStagesFromTemplate, expandPromptTemplate, getPipelineTemplate } from './templates';
import { verificationEvidenceRepository } from '@/db/repositories/verification-evidence-repository';
import { WorkspaceFS } from '@/security/workspace-fs';
import type { SideEffectCounters } from '@/core/swarm/receipt';
import { countChangedFiles, snapshotWorkspace, type WorkspaceSnapshot } from './workspace-snapshot';
import { appendSources, type QAValidationResult } from './types';
import { type AuditScopeStage, auditVerdictFailure, coverageScope, unaddressedDoubt, uncoveredStages } from './audit-coverage';

/**
 * The stages an auditor at `qaIndex` is accountable for.
 *
 * Two ways in, and they are deliberately different:
 * - it DECLARED it produces artifacts (the coverage rule). Declared, never
 *   inferred from the stage name — a `Research & Discovery` stage legitimately
 *   produces nothing and must not be gated for coverage.
 * - it handed off saying its own confidence was `low` (the doubt rule), which
 *   applies whether or not it wrote anything. A shaky architecture stage is
 *   exactly the doubt that would otherwise be inherited in silence.
 *
 * Confidence comes from each stage's handoff block, keyed by STAGE INDEX. A
 * pipeline recipe may legitimately reuse a stage name (nothing enforces
 * uniqueness on imported recipes), and keying by name would let a later
 * occurrence's confidence overwrite an earlier one's — losing real doubt in one
 * direction and inventing it in the other. A stage that emitted no handoff
 * simply carries no confidence: a missing signal, not a low one.
 */
export function auditScopeBefore(
  qaIndex: number,
  names: string[],
  producesArtifacts: Array<boolean | undefined>,
  confidenceByIndex: Map<number, 'high' | 'medium' | 'low'> = new Map(),
): AuditScopeStage[] {
  const scope: AuditScopeStage[] = [];
  for (let k = 0; k < qaIndex && k < names.length; k++) {
    const confidence = confidenceByIndex.get(k);
    if (producesArtifacts[k] || confidence === 'low') {
      scope.push({ name: names[k], producesArtifacts: !!producesArtifacts[k], confidence });
    }
  }
  return scope;
}

/** Each stage's self-reported handoff confidence, keyed by stage index. */
export function handoffConfidenceByStage(chain: HandoffContext[]): Map<number, 'high' | 'medium' | 'low'> {
  const byIndex = new Map<number, 'high' | 'medium' | 'low'>();
  for (const handoff of chain) {
    const index = handoff.from.stageIndex;
    if (typeof index === 'number' && handoff.confidence) byIndex.set(index, handoff.confidence);
  }
  return byIndex;
}

/**
 * Resolve a per-stage model override (a bound model name or id) to a concrete
 * modelId. Returns undefined when no override is set; throws (fail loud) when an
 * override names a model that isn't registered/enabled.
 */
async function resolveStageModelId(
  stageModel: string | undefined,
  registry: ModelRegistry,
): Promise<string | undefined> {
  if (!stageModel) return undefined;
  const model = (await registry.getModel(stageModel)) || (await registry.getModelByModelId(stageModel));
  if (!model) {
    throw new Error(
      `Pipeline stage has model override '${stageModel}' but no such model is registered. ` +
        `Fix the recipe's stage model or clear it.`,
    );
  }
  return model.modelId;
}

/** What a stage said it was for. Both flags are opt-in declarations from the
 *  template — never inferred from a stage's name or its prompt wording. */
export interface StageDeclaration {
  producesArtifacts?: boolean;
  runsCommands?: boolean;
}

/**
 * The evidence-gate decision, with no IO so it is directly testable.
 *
 * Returns the failure reason when a stage did demonstrably none of what it
 * DECLARED it was for, else null (= let the stage complete). Two declarations,
 * checked independently — a stage may make either, both, or neither.
 *
 * **`producesArtifacts`** — TWO signals, and either one showing work is enough:
 *
 * - `counters.filesChanged` — file-mutating TOOL calls. Blind to anything
 *   written through `shell__run` (heredoc, `sed -i`, a generator).
 * - `filesTouched` — files that actually differ on disk across the stage
 *   (`workspace-snapshot.ts`). Blind to which tool did it, which is the point,
 *   but sees the whole workspace including a concurrent pipeline's writes.
 *
 * Requiring only one is deliberate. Each is blind where the other sees, so an
 * AND would fail every stage that used only the tool the other signal misses —
 * which is precisely the false positive this gate had: a real `Implement Fix`
 * stage rewrote two files through the shell and was failed for "changed 0 files".
 *
 * **`runsCommands`** — a stage whose purpose is to EXECUTE (run the suite, the
 * linter, the build) and which ran zero commands did not do its job, however
 * confident its prose. This is the "declared purpose vs receipt" check: a
 * Testing agent that announced it could not run shell, simulated the run, and
 * reported "18 passed, 0 failed" was previously accepted because nothing
 * compared its honest `commandsRun: 0` against what the stage was for.
 *
 * `counters` here are the STAGE's, not one worker's — `stageCounters()` folds in
 * every swarm child, so a stage that delegated its shell work still counts it.
 *
 * "We could not measure" always passes, for every signal:
 * - `counters === null` — the worker exposed no tally (a CLI worker, say).
 * - `filesTouched === null` — no usable snapshot (root unreadable, tree too big).
 * Failing a run we merely failed to observe is the worse error: it fails work
 * that actually succeeded. The gate only bites when a signal is present AND says
 * nothing happened.
 */
export function stageEvidenceFailure(
  declared: StageDeclaration,
  counters: SideEffectCounters | null,
  filesTouched: number | null = null,
): string | null {
  if (counters === null) return null;

  const reasons: string[] = [];

  if (declared.producesArtifacts && !(filesTouched !== null && filesTouched > 0) && counters.filesChanged === 0) {
    // Name which evidence was actually consulted, so a failure is auditable
    // without re-running it: "0 files" from counters alone is a much weaker claim
    // than "0 files, and the workspace is byte-identical".
    const onDisk = filesTouched === null ? 'no workspace snapshot' : 'workspace unchanged on disk';
    reasons.push(
      `changed 0 files (${counters.toolCalls} tool calls, ${counters.commandsRun} commands, ` +
        `${counters.toolErrors} tool errors; ${onDisk})`,
    );
  }

  if (declared.runsCommands && counters.commandsRun === 0) {
    reasons.push(
      `ran 0 commands (${counters.toolCalls} tool calls, ${counters.toolErrors} tool errors) — ` +
        `a stage that verifies by executing cannot have executed nothing`,
    );
  }

  return reasons.length === 0 ? null : reasons.join('; and ');
}

export class PipelineManager {
  private get db() { return getDb(); }

  /**
   * Create a pipeline from a template type and start it.
   */
  async createAndRun(
    orchestratorAgentId: string,
    sessionId: string,
    userId: string,
    title: string,
    type: string,
    description: string,
    context: AgentContext,
    options?: { maxRetries?: number; params?: Record<string, unknown> },
  ): Promise<{ pipelineId: string; result: string }> {
    const template = await getPipelineTemplate(type);
    // Override maxRetries if provided
    if (options?.maxRetries != null) {
      for (const stage of template.stages) {
        if (stage.stageType === 'qa_validation') {
          stage.maxRetries = options.maxRetries;
        }
      }
    }
    // Resolve + validate recipe parameters against the template's typed defs
    // (fail loud on missing-required / unknown / type-mismatch). Substituted
    // into stage prompts as {{param.<key>}}.
    const paramVars = paramTemplateVars(resolveRecipeParams(template.parameters, options?.params ?? {}));
    const stageConfigs = buildStagesFromTemplate(template, description);

    // Create pipeline record
    const pipeline = await pipelineRepository.create({
      orchestratorAgentId,
      sessionId,
      userId,
      title,
      type,
      description,
      status: 'running',
      currentStageIndex: 0,
    });

    // Create stage records
    await pipelineRepository.createStages(stageConfigs.map(stageConfig => ({
      pipelineId: pipeline.id,
      name: stageConfig.name,
      role: stageConfig.role,
      toolIds: stageConfig.toolIds,
      systemPrompt: stageConfig.systemPrompt,
      input: '',
      requiresApproval: stageConfig.requiresApproval,
      stageIndex: stageConfig.stageIndex,
    })));

    const orchestrator = getOrchestratorService();
    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      data: { event: 'pipeline_created', pipelineId: pipeline.id, title, type, stageCount: stageConfigs.length },
      timestamp: new Date(),
    });

    coreLogger.info({ pipelineId: pipeline.id, type, stages: stageConfigs.length }, 'Pipeline created');

    // Run stages sequentially with structured handoff context
    let previousOutput = '';
    const handoffChain: HandoffContext[] = [];
    // Source attribution: every successfully completed stage (incl. QA
    // retries) appends one entry. Rendered into the pipeline summary as
    // `_Sources: stage(...), stage(...)_` to match the directResponse
    // and orchestrator footers.
    const pipelineSources: string[] = [];
    const stages = await this.getStages(pipeline.id);
    const stageConfBuilt = buildStagesFromTemplate(template, description);
    const retryCounts: Record<number, number> = {}; // Track retries per stage index
    // Filesystem half of the evidence gate — resolved once, used by every
    // declared stage and every retry of one.
    const workspaceRoot = await this.resolveWorkspaceRoot(sessionId);

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stageTemplate = template.stages[i];
      const builtStage = stageConfBuilt[i];

      // Build input from template, using structured handoff chain when available
      const handoffText = handoffChain.length > 0 ? formatHandoffChain(handoffChain) : '';
      let input = expandPromptTemplate(stageTemplate.promptTemplate, {
        description,
        previousOutput: handoffText || previousOutput,
        ...paramVars,
      });
      // Non-final stages emit a structured ```handoff block for the next stage
      // (Phase B3) — createHandoffContext below prefers it over regex scraping.
      if (i < stages.length - 1) input += HANDOFF_EMIT_INSTRUCTION;
      // QA stages also emit a machine-readable JSON verdict for parseQAResult
      // (B2). The two compose: B3 strips the handoff block from previousOutput
      // before parseQAResult runs, so the verdict is what the QA parser sees.
      if (builtStage.stageType === 'qa_validation') input += QA_VERDICT_JSON_INSTRUCTION;

      // Update stage input
      await this.updateStage(stage.id, { input, status: 'running' });
      await this.updatePipeline(pipeline.id, { currentStageIndex: i, status: 'running' });

      orchestrator['emit']({
        type: 'pipeline_event',
        sessionId,
        data: { event: 'stage_started', pipelineId: pipeline.id, stageId: stage.id, name: stage.name, index: i },
        timestamp: new Date(),
      });

      // Persist stage start as system message so it survives page reloads
      messageRepository.create({
        sessionId,
        role: 'system',
        content: `**Stage ${i + 1}: ${stage.name}** (${stage.role || 'agent'}) started`,
        metadata: { pipelineId: pipeline.id, stageId: stage.id, pipelineEvent: 'stage_started' },
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

      // Check if this stage requires approval
      if (stage.requiresApproval && previousOutput) {
        await this.updateStage(stage.id, { status: 'awaiting_approval' });
        await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

        orchestrator['emit']({
          type: 'pipeline_event',
          sessionId,
          data: { event: 'approval_required', pipelineId: pipeline.id, stageId: stage.id, name: stage.name },
          timestamp: new Date(),
        });

        // Request approval from user — show handoff summary if available
        const prevStageName = i > 0 ? stages[i - 1].name : 'Initial';
        const latestHandoff = handoffChain[handoffChain.length - 1];
        const approvalSummary = latestHandoff
          ? `Stage "${prevStageName}" completed.\n\n**Work done:** ${latestHandoff.completedWork.slice(0, 1500)}`
            + (latestHandoff.decisions.length > 0 ? `\n\n**Decisions:** ${latestHandoff.decisions.join('; ')}` : '')
          : `Stage "${prevStageName}" completed.\n\nResult:\n${(previousOutput || '').slice(0, 2000)}`;
        const approvalResult = await orchestrator.requestApproval(
          `Pipeline "${title}" — ${approvalSummary}`,
          `Proceed with next stage: "${stage.name}"?`,
          context,
          ['Approve', 'Skip', 'Stop Pipeline'],
        ) as { approved: boolean; response?: string };

        if (!approvalResult.approved || approvalResult.response === 'Stop Pipeline') {
          await this.updateStage(stage.id, { status: 'skipped' });
          await this.updatePipeline(pipeline.id, { status: 'paused', summary: `Stopped by user at stage: ${stage.name}` });
          return { pipelineId: pipeline.id, result: `Pipeline stopped at "${stage.name}".` };
        }

        if (approvalResult.response === 'Skip') {
          await this.updateStage(stage.id, { status: 'skipped' });
          continue;
        }

        await this.updateStage(stage.id, { status: 'approved', approvedAt: new Date() });
        await this.updatePipeline(pipeline.id, { status: 'running' });
      }

      // Emit stage_started so UI can show which pipeline stage is active
      orchestrator['emit']({
        type: 'pipeline_event',
        sessionId,
        data: { event: 'stage_started', pipelineId: pipeline.id, stageId: stage.id, name: stage.name, role: stage.role, index: i },
        timestamp: new Date(),
      });

      // Spawn worker for this stage with structured handoff context
      try {
        // Resolve the model for the stage's topic so pipeline steps use the
        // correct topic-specific model instead of the role's defaultTopic.
        const stageTopic = stage.role; // role is set from the step's topic field
        const registry = getModelRegistry();
        // Per-stage model override (recipes) wins over the topic binding when set.
        const stageModelId = await resolveStageModelId(stageTemplate.model, registry);
        const topicModel = await registry.getModelForTopic(stageTopic);
        const modelOverride = stageModelId || topicModel?.modelId || undefined;

        // Captured before `previousOutput` is reassigned below, so an
        // auditor-only re-run (audit-coverage gate) can re-ask this stage the
        // exact same question instead of reconstructing it.
        const stageContext = handoffText || previousOutput;

        const before = await this.snapshotStage(builtStage.producesArtifacts, workspaceRoot);

        let counters: SideEffectCounters | null = null;
        const result = await orchestrator.spawnWorker(
          stage.role,
          input,
          stageContext,
          { ...context, stageName: stage.name } as any,
          {
            ...(modelOverride ? { model: modelOverride } : {}),
            swarmParent: {
              id: orchestratorAgentId,
              rootSessionId: sessionId,
              topicPath: `pipeline/${pipeline.id}/${stage.name}`,
              subtopic: stage.name,
            },
            onCounters: (c) => { counters = c; },
          },
        );

        // Evidence gate BEFORE the stage is marked complete — throws into the
        // catch below, which already fails the stage and the pipeline.
        await this.assertStageEvidence({
          sessionId,
          pipelineId: pipeline.id,
          stageName: stage.name,
          declared: builtStage,
          before,
          workspaceRoot,
          counters,
        });

        // Parse the handoff from the RAW output (which carries the ```handoff
        // block), but persist/forward the STRIPPED output so the internal block
        // is never shown to the user or bled into the next stage's prose (B3).
        const rawOutput = String(result || '');
        previousOutput = stripHandoffBlock(rawOutput);
        pipelineSources.push(`stage(${i + 1}: ${stage.name}/${stage.role})`);

        await this.updateStage(stage.id, {
          status: 'completed',
          output: previousOutput,
          completedAt: new Date(),
        });

        // Build structured handoff for the next stage
        if (i < stages.length - 1) {
          const nextStage = stages[i + 1];
          const handoff = await createHandoffContext({
            from: { role: stage.role, stageName: stage.name, stageIndex: i },
            to: { role: nextStage.role, stageName: nextStage.name, stageIndex: i + 1 },
            originalRequest: description,
            stageOutput: rawOutput,
          });
          handoffChain.push(handoff);
        }

        // Generate a brief summary of what this stage accomplished
        const stageSummary = previousOutput.length > 300
          ? previousOutput.slice(0, 300).replace(/\n/g, ' ').trim() + '...'
          : previousOutput.replace(/\n/g, ' ').trim();

        orchestrator['emit']({
          type: 'pipeline_event',
          sessionId,
          data: {
            event: 'stage_completed',
            pipelineId: pipeline.id,
            stageId: stage.id,
            name: stage.name,
            role: stage.role,
            summary: stageSummary.slice(0, 200),
          },
          timestamp: new Date(),
        });

        // Persist stage completion as system message
        messageRepository.create({
          sessionId,
          role: 'system',
          content: `**${stage.name}** (${stage.role || 'agent'}) completed: ${stageSummary.slice(0, 200)}`,
          metadata: { pipelineId: pipeline.id, stageId: stage.id, pipelineEvent: 'stage_completed' },
        }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

        // --- QA Validation retry loop ---
        if (builtStage.stageType === 'qa_validation') {
          const maxRetries = builtStage.maxRetries ?? 3;
          const retryTargetIndex = builtStage.retryTargetStage ?? (i > 0 ? i - 1 : 0);
          const retryTargetStage = stages[retryTargetIndex];
          const retryTargetTemplate = template.stages[retryTargetIndex];

          if (!retryTargetStage || !retryTargetTemplate) {
            coreLogger.warn({ pipelineId: pipeline.id, stageIndex: i, retryTargetIndex }, 'QA retry target stage not found, skipping retry logic');
          } else {
            // Store the original input for the retry target stage
            const originalTargetInput = expandPromptTemplate(retryTargetTemplate.promptTemplate, {
              description,
              previousOutput: retryTargetIndex > 0 ? (stages[retryTargetIndex - 1] as any).output || '' : '',
              ...paramVars,
            });

            const auditScope = auditScopeBefore(
              i,
              stages.map((s) => s.name),
              template.stages.map((s) => s.producesArtifacts),
              handoffConfidenceByStage(handoffChain),
            );
            const qaEvidence = { sessionId, pipelineId: pipeline.id, stageName: stage.name };

            let qaResult = await this.gateQaVerdict(previousOutput, auditScope, qaEvidence);
            retryCounts[i] = retryCounts[i] || 0;
            // The work the auditor is judging, carried ACROSS retries. An
            // auditor-only re-run must re-read the newest implementation
            // output, not the one captured before the loop — otherwise a real
            // retry followed by a rubber stamp re-judges superseded work.
            let auditedOutput = stageContext;

            while (qaResult && !qaResult.passed && retryCounts[i] < maxRetries) {
              retryCounts[i]++;
              const attempt = retryCounts[i];
              // An audit-gate rejection faults the REPORT, not the code: re-run
              // the auditor alone. Re-running the implementation would burn a
              // paid run on work that was fine and can trip its own evidence
              // gate (a re-run with nothing to do changes 0 files).
              const auditorOnly = qaResult.auditGateFailed === true;

              coreLogger.info(
                { pipelineId: pipeline.id, qaStage: stage.name, retryTarget: retryTargetStage.name, attempt, maxRetries, auditorOnly },
                auditorOnly ? 'Audit-coverage gate rejected the verdict, re-running the QA stage' : 'QA validation failed, retrying implementation stage',
              );

              orchestrator['emit']({
                type: 'pipeline_event',
                sessionId,
                data: {
                  event: 'qa_retry',
                  pipelineId: pipeline.id,
                  qaStageId: stage.id,
                  retryTargetStageId: retryTargetStage.id,
                  attempt,
                  maxRetries,
                  issues: qaResult.issues,
                },
                timestamp: new Date(),
              });

              // Re-run the target stage with QA feedback
              const retryInput = `Previous attempt had issues:\n${qaResult.feedback}\n\nPlease fix these issues:\n${qaResult.issues.join('\n')}\n\nOriginal task:\n${originalTargetInput}`;

              if (!auditorOnly) {
                await this.updateStage(retryTargetStage.id, { input: retryInput, status: 'running' });
              }

              try {
                // What the re-run auditor will read. On the auditor-only path
                // the target stage is not re-run, so this stays the newest
                // output the auditor already had — same work, re-judged.
                let retryOutput = auditedOutput;

                if (!auditorOnly) {
                  // Per-stage model override wins over the topic binding (same as
                  // the initial run) so retries don't silently switch models.
                  const retryStageModelId = await resolveStageModelId(retryTargetTemplate.model, registry);
                  const retryTopicModel = await registry.getModelForTopic(retryTargetStage.role);
                  const retryModelOverride = retryStageModelId || retryTopicModel?.modelId || undefined;

                  const retryDeclared = template.stages[retryTargetIndex];
                  const retryBefore = await this.snapshotStage(retryDeclared?.producesArtifacts, workspaceRoot);

                  let retryCounters: SideEffectCounters | null = null;
                  const retryResult = await orchestrator.spawnWorker(
                    retryTargetStage.role,
                    retryInput,
                    '',
                    context,
                    {
                      ...(retryModelOverride ? { model: retryModelOverride } : {}),
                      swarmParent: {
                        id: orchestratorAgentId,
                        rootSessionId: sessionId,
                        topicPath: `pipeline/${pipeline.id}/${retryTargetStage.name}#retry${attempt}`,
                        subtopic: `${retryTargetStage.name} (retry ${attempt})`,
                      },
                      onCounters: (c) => { retryCounters = c; },
                    },
                  );

                  await this.assertStageEvidence({
                    sessionId,
                    pipelineId: pipeline.id,
                    stageName: retryTargetStage.name,
                    declared: retryDeclared,
                    before: retryBefore,
                    workspaceRoot,
                    counters: retryCounters,
                  });

                  retryOutput = String(retryResult || '');
                  auditedOutput = retryOutput;
                  await this.updateStage(retryTargetStage.id, {
                    status: 'completed',
                    output: retryOutput,
                    completedAt: new Date(),
                  });

                  orchestrator['emit']({
                    type: 'pipeline_event',
                    sessionId,
                    data: { event: 'stage_completed', pipelineId: pipeline.id, stageId: retryTargetStage.id, name: retryTargetStage.name, note: `retry attempt ${attempt}` },
                    timestamp: new Date(),
                  });
                }

                // Re-run QA stage with the newest output. Built the same way on
                // both paths so an auditor-only re-run cannot drift from a
                // normal one; only the rejection notice differs. Re-append the
                // JSON verdict instruction (B2) — without it the retried QA
                // falls back to prose parsing, which can return null and
                // silently pass a still-failing stage.
                const qaRetryInput = expandPromptTemplate(stageTemplate.promptTemplate, {
                    description,
                    previousOutput: retryOutput,
                    ...paramVars,
                  }) + QA_VERDICT_JSON_INSTRUCTION
                  + (auditorOnly ? `\n\n---\nYOUR PREVIOUS VERDICT WAS REJECTED — ${qaResult.feedback}` : '');

                await this.updateStage(stage.id, { input: qaRetryInput, status: 'running' });

                // Per-stage model override wins over the topic binding.
                const qaStageModelId = await resolveStageModelId(stageTemplate.model, registry);
                const qaTopicModel = await registry.getModelForTopic(stage.role);
                const qaModelOverride = qaStageModelId || qaTopicModel?.modelId || undefined;

                const qaRetryBefore = await this.snapshotStage(builtStage.producesArtifacts, workspaceRoot);

                let qaRetryCounters: SideEffectCounters | null = null;
                const qaRetryResult = await orchestrator.spawnWorker(
                  stage.role,
                  qaRetryInput,
                  retryOutput,
                  context,
                  {
                    ...(qaModelOverride ? { model: qaModelOverride } : {}),
                    swarmParent: {
                      id: orchestratorAgentId,
                      rootSessionId: sessionId,
                      topicPath: `pipeline/${pipeline.id}/${stage.name}#qa-retry${attempt}`,
                      subtopic: `${stage.name} QA (retry ${attempt})`,
                    },
                    onCounters: (c) => { qaRetryCounters = c; },
                  },
                );

                await this.assertStageEvidence({
                  sessionId,
                  pipelineId: pipeline.id,
                  stageName: stage.name,
                  declared: builtStage,
                  before: qaRetryBefore,
                  workspaceRoot,
                  counters: qaRetryCounters,
                });

                previousOutput = String(qaRetryResult || '');
                await this.updateStage(stage.id, {
                  status: 'completed',
                  output: previousOutput,
                  completedAt: new Date(),
                });

                qaResult = await this.gateQaVerdict(previousOutput, auditScope, qaEvidence);
              } catch (retryError) {
                const errorMsg = (retryError as Error).message;
                coreLogger.error({ error: retryError, pipelineId: pipeline.id, attempt, auditorOnly }, 'QA retry stage failed');
                // Fail the stage that actually ran. On the auditor-only path
                // the target stage was never touched this attempt, so marking
                // it failed would corrupt the audit trail this gate exists to
                // keep honest.
                await this.updateStage(auditorOnly ? stage.id : retryTargetStage.id, { status: 'failed', error: errorMsg });
                await this.updatePipeline(pipeline.id, { status: 'failed', summary: `Failed during QA retry attempt ${attempt}: ${errorMsg}` });
                return { pipelineId: pipeline.id, result: `Pipeline failed during QA retry attempt ${attempt}: ${errorMsg}` };
              }
            }

            // If still failing after max retries, escalate for human approval
            if (qaResult && !qaResult.passed && retryCounts[i] >= maxRetries) {
              coreLogger.warn({ pipelineId: pipeline.id, attempts: retryCounts[i] }, 'QA validation exhausted retries, requesting human approval');

              orchestrator['emit']({
                type: 'pipeline_event',
                sessionId,
                data: {
                  event: 'qa_escalation',
                  pipelineId: pipeline.id,
                  qaStageId: stage.id,
                  attempts: retryCounts[i],
                  issues: qaResult.issues,
                },
                timestamp: new Date(),
              });

              await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

              const escalationResult = await orchestrator.requestApproval(
                `QA validation failed after ${retryCounts[i]} attempts.\n\nRemaining issues:\n${qaResult.issues.join('\n')}\n\nFeedback: ${qaResult.feedback}`,
                `Continue pipeline despite QA failures, or abort?`,
                context,
                ['Continue Anyway', 'Abort Pipeline'],
              ) as { approved: boolean; response?: string };

              if (!escalationResult.approved || escalationResult.response === 'Abort Pipeline') {
                await this.updatePipeline(pipeline.id, {
                  status: 'failed',
                  summary: `QA failed after ${retryCounts[i]} attempts. Aborted by user.\n\nIssues:\n${qaResult.issues.join('\n')}`,
                });
                return {
                  pipelineId: pipeline.id,
                  result: `Pipeline aborted: QA failed after ${retryCounts[i]} attempts.\n\nUnresolved issues:\n${qaResult.issues.join('\n')}`,
                };
              }

              await this.updatePipeline(pipeline.id, { status: 'running' });
              coreLogger.info({ pipelineId: pipeline.id }, 'User approved continuing despite QA failures');
            }
          }
        }
      } catch (error) {
        const errorMsg = (error as Error).message;
        await this.updateStage(stage.id, { status: 'failed', error: errorMsg });
        await this.updatePipeline(pipeline.id, { status: 'failed', summary: `Failed at stage: ${stage.name} — ${errorMsg}` });

        coreLogger.error({ error, pipelineId: pipeline.id, stage: stage.name }, 'Pipeline stage failed');
        getNotificationService().notify(
          pipeline.userId,
          'pipeline_error',
          `Pipeline "${title}" failed`,
          `Failed at stage "${stage.name}": ${errorMsg}`,
          { pipelineId: pipeline.id, stage: stage.name },
        ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));
        return { pipelineId: pipeline.id, result: `Pipeline failed at "${stage.name}": ${errorMsg}` };
      }
    }

    // All stages complete
    const baseSummary = `Pipeline "${title}" completed successfully. Final output:\n\n${previousOutput}`;
    const summary = appendSources(baseSummary, pipelineSources);
    await this.updatePipeline(pipeline.id, {
      status: 'completed',
      summary,
      completedAt: new Date(),
    });

    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      data: { event: 'pipeline_completed', pipelineId: pipeline.id, title },
      timestamp: new Date(),
    });

    getNotificationService().notify(
      pipeline.userId,
      'pipeline_complete',
      `Pipeline "${title}" completed`,
      (previousOutput || '').slice(0, 200),
      { pipelineId: pipeline.id },
    ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

    return { pipelineId: pipeline.id, result: summary };
  }

  /**
   * Create and run a pipeline from a DB template.
   */
  async createFromTemplate(
    templateId: string,
    orchestratorAgentId: string,
    sessionId: string,
    userId: string,
    description: string,
    context: AgentContext,
  ): Promise<{ pipelineId: string; result: string }> {
    const [template] = await this.db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.id, templateId))
      .limit(1);

    if (!template) {
      return { pipelineId: '', result: `Template "${templateId}" not found.` };
    }

    const steps = template.steps as PipelineStepConfig[];
    const registry = getModelRegistry();

    // Create pipeline record
    const pipeline = await pipelineRepository.create({
      orchestratorAgentId,
      sessionId,
      userId,
      title: template.name,
      type: 'template',
      description,
      status: 'running',
      currentStageIndex: 0,
    });

    // Create stages from template steps
    const stageRows: NewPipelineStage[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      // Per-stage model override (recipes) wins over the topic binding when set.
      const stageModelId = await resolveStageModelId(step.model, registry);
      const model = stageModelId ? null : await registry.getModelForTopic(step.topic);
      stageRows.push({
        pipelineId: pipeline.id,
        name: step.name,
        role: step.topic,
        model: stageModelId || model?.modelId || undefined,
        toolIds: step.toolIds || [],
        systemPrompt: step.promptTemplate || `Execute: ${step.name}`,
        input: '',
        requiresApproval: step.requiresApproval,
        stageIndex: i,
      });
    }
    await pipelineRepository.createStages(stageRows);

    coreLogger.info({ pipelineId: pipeline.id, template: template.name, stages: steps.length }, 'Pipeline created from template');

    // Run using the same stage execution logic as createAndRun
    return this.runStages(pipeline, context, description, sessionId);
  }

  /**
   * List pipeline templates for a user.
   */
  async listTemplates(userId: string) {
    return this.db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.userId, userId))
      .orderBy(desc(pipelineTemplates.createdAt));
  }

  /**
   * Run pipeline stages sequentially (shared logic for DB template pipelines).
   */
  private async runStages(
    pipeline: Pipeline,
    context: AgentContext,
    description: string,
    sessionId: string,
  ): Promise<{ pipelineId: string; result: string }> {
    const orchestrator = getOrchestratorService();
    const stages = await this.getStages(pipeline.id);
    let previousOutput = '';
    const handoffChain: HandoffContext[] = [];
    const pipelineSources: string[] = [];

    // Retrieve step configs from the DB template to check stageType
    const [templateRecord] = await this.db
      .select()
      .from(pipelineTemplates)
      .where(eq(pipelineTemplates.name, pipeline.title))
      .limit(1);
    const stepConfigs = (templateRecord?.steps as PipelineStepConfig[]) || [];
    const retryCounts: Record<number, number> = {};
    // Filesystem half of the evidence gate — resolved once, used by every
    // declared stage and every retry of one.
    const workspaceRoot = await this.resolveWorkspaceRoot(sessionId);

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      const stepConfig = stepConfigs[i];
      // Build input using structured handoff chain when available
      const handoffText = handoffChain.length > 0 ? formatHandoffChain(handoffChain) : '';
      const contextInput = handoffText || previousOutput;
      let input = stage.systemPrompt ? `${stage.systemPrompt}\n\nContext: ${description}\n\n${contextInput}` : description;
      // Non-final stages emit a structured ```handoff block (Phase B3).
      if (i < stages.length - 1) input += HANDOFF_EMIT_INSTRUCTION;
      // QA stages also emit a JSON verdict for parseQAResult (B2); composes
      // with B3 (the handoff block is stripped before parseQAResult).
      if (stepConfig?.stageType === 'qa_validation') input += QA_VERDICT_JSON_INSTRUCTION;

      await this.updateStage(stage.id, { input, status: 'running' });
      await this.updatePipeline(pipeline.id, { currentStageIndex: i, status: 'running' });

      // Emit stage_started event for UI
      orchestrator['emit']({
        type: 'pipeline_event',
        sessionId,
        data: { event: 'stage_started', pipelineId: pipeline.id, stageId: stage.id, name: stage.name, role: stage.role, index: i },
        timestamp: new Date(),
      });

      // Persist stage start as system message
      messageRepository.create({
        sessionId,
        role: 'system',
        content: `**Stage ${i + 1}: ${stage.name}** (${stage.role || 'agent'}) started`,
        metadata: { pipelineId: pipeline.id, stageId: stage.id, pipelineEvent: 'stage_started' },
      }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

      if (stage.requiresApproval && previousOutput) {
        await this.updateStage(stage.id, { status: 'awaiting_approval' });
        await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

        // Show handoff summary in approval message if available
        const latestHandoff = handoffChain[handoffChain.length - 1];
        const approvalSummary = latestHandoff
          ? `Stage "${stage.name}" ready.\n\n**Previous work:** ${latestHandoff.completedWork.slice(0, 1500)}`
            + (latestHandoff.decisions.length > 0 ? `\n\n**Decisions:** ${latestHandoff.decisions.join('; ')}` : '')
          : `Stage "${stage.name}" ready.\n\nPrevious result:\n${(previousOutput || '').slice(0, 2000)}`;

        const approvalResult = await orchestrator.requestApproval(
          `Pipeline "${pipeline.title}" — ${approvalSummary}`,
          `Proceed with "${stage.name}"?`,
          context,
          ['Approve', 'Skip', 'Stop Pipeline'],
        ) as { approved: boolean; response?: string };

        if (!approvalResult.approved || approvalResult.response === 'Stop Pipeline') {
          await this.updateStage(stage.id, { status: 'skipped' });
          await this.updatePipeline(pipeline.id, { status: 'paused', summary: `Stopped at: ${stage.name}` });
          return { pipelineId: pipeline.id, result: `Pipeline stopped at "${stage.name}".` };
        }
        if (approvalResult.response === 'Skip') {
          await this.updateStage(stage.id, { status: 'skipped' });
          continue;
        }
        await this.updateStage(stage.id, { status: 'approved', approvedAt: new Date() });
        await this.updatePipeline(pipeline.id, { status: 'running' });
      }

      try {
        // See the sibling loop: captured before `previousOutput` is reassigned
        // so an auditor-only re-run can re-ask the same question.
        const stageContext = handoffText || previousOutput;

        const before = await this.snapshotStage(stepConfig?.producesArtifacts, workspaceRoot);

        let counters: SideEffectCounters | null = null;
        const result = await orchestrator.spawnWorker(
          stage.role,
          input,
          stageContext,
          context,
          {
            swarmParent: {
              id: pipeline.orchestratorAgentId,
              rootSessionId: sessionId,
              topicPath: `pipeline/${pipeline.id}/${stage.name}`,
              subtopic: stage.name,
            },
            onCounters: (c) => { counters = c; },
          },
        );

        // Evidence gate BEFORE completion — throws into the catch below.
        await this.assertStageEvidence({
          sessionId,
          pipelineId: pipeline.id,
          stageName: stage.name,
          declared: stepConfig,
          before,
          workspaceRoot,
          counters,
        });

        // Strip the internal ```handoff block before persist/forward (B3);
        // parse the handoff chain from the raw output that still carries it.
        const rawOutput = String(result || '');
        previousOutput = stripHandoffBlock(rawOutput);
        pipelineSources.push(`stage(${i + 1}: ${stage.name}/${stage.role})`);
        await this.updateStage(stage.id, {
          status: 'completed',
          output: previousOutput,
          completedAt: new Date(),
        });

        // Build structured handoff for the next stage
        if (i < stages.length - 1) {
          const nextStage = stages[i + 1];
          const handoff = await createHandoffContext({
            from: { role: stage.role, stageName: stage.name, stageIndex: i },
            to: { role: nextStage.role, stageName: nextStage.name, stageIndex: i + 1 },
            originalRequest: description,
            stageOutput: rawOutput,
          });
          handoffChain.push(handoff);
        }

        // Emit stage_completed event for UI
        const stageSummary = previousOutput.length > 300
          ? previousOutput.slice(0, 300).replace(/\n/g, ' ').trim() + '...'
          : previousOutput.replace(/\n/g, ' ').trim();

        orchestrator['emit']({
          type: 'pipeline_event',
          sessionId,
          data: {
            event: 'stage_completed',
            pipelineId: pipeline.id,
            stageId: stage.id,
            name: stage.name,
            role: stage.role,
            summary: stageSummary.slice(0, 200),
          },
          timestamp: new Date(),
        });

        // Persist stage completion as system message
        messageRepository.create({
          sessionId,
          role: 'system',
          content: `**${stage.name}** (${stage.role || 'agent'}) completed: ${stageSummary.slice(0, 200)}`,
          metadata: { pipelineId: pipeline.id, stageId: stage.id, pipelineEvent: 'stage_completed' },
        }).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

        // --- QA Validation retry loop for DB template pipelines ---
        if (stepConfig?.stageType === 'qa_validation') {
          const maxRetries = stepConfig.maxRetries ?? 3;
          const retryTargetIndex = stepConfig.retryTargetStage ?? (i > 0 ? i - 1 : 0);
          const retryTargetStage = stages[retryTargetIndex];

          if (!retryTargetStage) {
            coreLogger.warn({ pipelineId: pipeline.id, stageIndex: i, retryTargetIndex }, 'QA retry target stage not found');
          } else {
            const originalTargetInput = retryTargetStage.systemPrompt
              ? `${retryTargetStage.systemPrompt}\n\nContext: ${description}\n\n${retryTargetIndex > 0 ? (stages[retryTargetIndex - 1] as any).output || '' : ''}`
              : description;

            const auditScope = auditScopeBefore(
              i,
              stages.map((s) => s.name),
              stepConfigs.map((s) => s?.producesArtifacts),
              handoffConfidenceByStage(handoffChain),
            );
            const qaEvidence = { sessionId, pipelineId: pipeline.id, stageName: stage.name };

            let qaResult = await this.gateQaVerdict(previousOutput, auditScope, qaEvidence);
            retryCounts[i] = retryCounts[i] || 0;
            // See the sibling loop: the newest work under audit, carried across
            // retries so an auditor-only re-run never re-judges superseded output.
            let auditedOutput = stageContext;

            while (qaResult && !qaResult.passed && retryCounts[i] < maxRetries) {
              retryCounts[i]++;
              const attempt = retryCounts[i];
              // See the sibling loop: an audit-gate rejection re-runs the
              // auditor alone, never the implementation stage.
              const auditorOnly = qaResult.auditGateFailed === true;

              coreLogger.info(
                { pipelineId: pipeline.id, qaStage: stage.name, retryTarget: retryTargetStage.name, attempt, maxRetries, auditorOnly },
                auditorOnly ? 'Audit-coverage gate rejected the verdict, re-running the QA stage' : 'QA validation failed, retrying implementation stage',
              );

              const retryInput = `Previous attempt had issues:\n${qaResult.feedback}\n\nPlease fix these issues:\n${qaResult.issues.join('\n')}\n\nOriginal task:\n${originalTargetInput}`;

              let retryOutput = auditedOutput;

              if (!auditorOnly) {
                await this.updateStage(retryTargetStage.id, { input: retryInput, status: 'running' });

                const retryDeclared = stepConfigs[retryTargetIndex];
                const retryBefore = await this.snapshotStage(retryDeclared?.producesArtifacts, workspaceRoot);

                let retryCounters: SideEffectCounters | null = null;
                const retryResult = await orchestrator.spawnWorker(
                  retryTargetStage.role,
                  retryInput,
                  '',
                  context,
                  {
                    swarmParent: {
                      id: pipeline.orchestratorAgentId,
                      rootSessionId: sessionId,
                      topicPath: `pipeline/${pipeline.id}/${retryTargetStage.name}#retry${attempt}`,
                      subtopic: `${retryTargetStage.name} (retry ${attempt})`,
                    },
                    onCounters: (c) => { retryCounters = c; },
                  },
                );

                await this.assertStageEvidence({
                  sessionId,
                  pipelineId: pipeline.id,
                  stageName: retryTargetStage.name,
                  declared: retryDeclared,
                  before: retryBefore,
                  workspaceRoot,
                  counters: retryCounters,
                });

                retryOutput = String(retryResult || '');
                auditedOutput = retryOutput;
                await this.updateStage(retryTargetStage.id, {
                  status: 'completed',
                  output: retryOutput,
                  completedAt: new Date(),
                });
              }

              // Re-run QA stage. Built the same way on both paths so an
              // auditor-only re-run cannot drift from a normal one; only the
              // rejection notice differs. Re-append the JSON verdict
              // instruction (B2) so the retried QA emits a parseable verdict
              // instead of falling back to prose.
              const qaRetryInput = (stage.systemPrompt
                  ? `${stage.systemPrompt}\n\nContext: ${description}\n\n${retryOutput}`
                  : `${description}\n\n${retryOutput}`) + QA_VERDICT_JSON_INSTRUCTION
                + (auditorOnly ? `\n\n---\nYOUR PREVIOUS VERDICT WAS REJECTED — ${qaResult.feedback}` : '');

              await this.updateStage(stage.id, { input: qaRetryInput, status: 'running' });

              const qaRetryBefore = await this.snapshotStage(stepConfig?.producesArtifacts, workspaceRoot);

              let qaRetryCounters: SideEffectCounters | null = null;
              const qaRetryResult = await orchestrator.spawnWorker(
                stage.role,
                qaRetryInput,
                retryOutput,
                context,
                {
                  swarmParent: {
                    id: pipeline.orchestratorAgentId,
                    rootSessionId: sessionId,
                    topicPath: `pipeline/${pipeline.id}/${stage.name}#qa-retry${attempt}`,
                    subtopic: `${stage.name} QA (retry ${attempt})`,
                  },
                  onCounters: (c) => { qaRetryCounters = c; },
                },
              );

              await this.assertStageEvidence({
                sessionId,
                pipelineId: pipeline.id,
                stageName: stage.name,
                declared: stepConfig,
                before: qaRetryBefore,
                workspaceRoot,
                counters: qaRetryCounters,
              });

              previousOutput = String(qaRetryResult || '');
              await this.updateStage(stage.id, {
                status: 'completed',
                output: previousOutput,
                completedAt: new Date(),
              });

              qaResult = await this.gateQaVerdict(previousOutput, auditScope, qaEvidence);
            }

            // Escalate if max retries exhausted
            if (qaResult && !qaResult.passed && retryCounts[i] >= maxRetries) {
              coreLogger.warn({ pipelineId: pipeline.id, attempts: retryCounts[i] }, 'QA validation exhausted retries');

              await this.updatePipeline(pipeline.id, { status: 'awaiting_approval' });

              const escalationResult = await orchestrator.requestApproval(
                `QA validation failed after ${retryCounts[i]} attempts.\n\nRemaining issues:\n${qaResult.issues.join('\n')}\n\nFeedback: ${qaResult.feedback}`,
                `Continue pipeline despite QA failures, or abort?`,
                context,
                ['Continue Anyway', 'Abort Pipeline'],
              ) as { approved: boolean; response?: string };

              if (!escalationResult.approved || escalationResult.response === 'Abort Pipeline') {
                await this.updatePipeline(pipeline.id, {
                  status: 'failed',
                  summary: `QA failed after ${retryCounts[i]} attempts. Aborted by user.\n\nIssues:\n${qaResult.issues.join('\n')}`,
                });
                return {
                  pipelineId: pipeline.id,
                  result: `Pipeline aborted: QA failed after ${retryCounts[i]} attempts.`,
                };
              }

              await this.updatePipeline(pipeline.id, { status: 'running' });
            }
          }
        }
      } catch (error) {
        const errorMsg = (error as Error).message;
        await this.updateStage(stage.id, { status: 'failed', error: errorMsg });
        await this.updatePipeline(pipeline.id, { status: 'failed', summary: `Failed at: ${stage.name} — ${errorMsg}` });
        return { pipelineId: pipeline.id, result: `Pipeline failed at "${stage.name}": ${errorMsg}` };
      }
    }

    const baseSummary = `Pipeline "${pipeline.title}" completed.\n\n${previousOutput}`;
    const summary = appendSources(baseSummary, pipelineSources);
    await this.updatePipeline(pipeline.id, { status: 'completed', summary, completedAt: new Date() });

    // Emit pipeline_completed event for UI
    orchestrator['emit']({
      type: 'pipeline_event',
      sessionId,
      data: { event: 'pipeline_completed', pipelineId: pipeline.id, title: pipeline.title },
      timestamp: new Date(),
    });

    getNotificationService().notify(
      pipeline.userId,
      'pipeline_complete',
      `Pipeline "${pipeline.title}" completed`,
      (previousOutput || '').slice(0, 200),
      { pipelineId: pipeline.id },
    ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in pipeline-manager'));

    return { pipelineId: pipeline.id, result: summary };
  }

  /**
   * Get pipeline by ID with stages.
   */
  async getPipeline(id: string): Promise<Pipeline | null> {
    return pipelineRepository.findById(id);
  }

  /**
   * Get stages for a pipeline, ordered by index.
   */
  async getStages(pipelineId: string): Promise<PipelineStageRow[]> {
    return this.db
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId))
      .orderBy(pipelineStages.stageIndex);
  }

  /**
   * List pipelines for a user.
   */
  async listByUser(userId: string): Promise<Pipeline[]> {
    return this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.userId, userId))
      .orderBy(desc(pipelines.createdAt));
  }

  /**
   * List all pipelines (admin).
   */
  async listAll(): Promise<Pipeline[]> {
    return this.db
      .select()
      .from(pipelines)
      .orderBy(desc(pipelines.createdAt));
  }

  /**
   * Stop a running pipeline.
   */
  async stop(pipelineId: string): Promise<boolean> {
    const pipeline = await this.getPipeline(pipelineId);
    if (!pipeline || pipeline.status === 'completed' || pipeline.status === 'failed') {
      return false;
    }

    await this.updatePipeline(pipelineId, {
      status: 'paused',
      summary: 'Pipeline stopped by user.',
    });

    // Mark running stages as skipped
    const stages = await this.getStages(pipelineId);
    for (const stage of stages) {
      if (stage.status === 'running' || stage.status === 'awaiting_approval') {
        await this.updateStage(stage.id, { status: 'skipped' });
      }
    }

    return true;
  }

  /**
   * Parse QA validation output into a structured result.
   *
   * Resolution order (most reliable → fuzziest):
   *   1. Strict JSON (with or without code fences) — what well-prompted
   *      agents emit when asked for a `{"passed":bool,...}` deliverable.
   *   2. Inline JSON keys (`"passed": true|false`) anywhere in prose.
   *   3. Prose verdict keywords matching the seed-template wording —
   *      `Overall status: PASS|FAIL|PASS WITH NOTES`,
   *      `Rate overall quality: Excellent|Good|Needs Work|Critical Issues`,
   *      bare `PASS` / `FAIL` headlines.
   *
   *   Why (3) exists: the built-in "Full Development Cycle" template
   *   prompts the agent to emit those exact verdicts in prose, not JSON.
   *   Without (3), the retry loop silently no-ops on a failing QA stage
   *   because `parseQAResult` returns null → `while (qaResult && ...)`
   *   short-circuits and the pipeline marks the stage "complete".
   */
  /**
   * Persist a QA verdict to the verification evidence ledger. Best-effort: a
   * ledger write must never break the pipeline, so failures are logged and
   * swallowed. Append-only — every verdict (initial + each retry) is a row.
   */
  /**
   * Evidence gate for a stage that DECLARED what it is for — leaving files
   * behind (`producesArtifacts`), executing something (`runsCommands`), or
   * both. Throws when the stage did none of what it declared, so the caller's
   * existing error path marks the stage — and the pipeline — failed. Without
   * this a "Full Development Cycle" reports seven green stages over an empty
   * workspace, which is the exact failure this gate exists for
   * (docs/plans/pipeline-evidence-gate.md).
   *
   * Three deliberate non-behaviours:
   * - An UNDECLARED stage is never gated and never even writes a row. Research
   *   and review stages legitimately write nothing.
   * - `counters === null` means "we could not measure", NOT "it did nothing" —
   *   it passes, loudly, and records `passed: true` with the gap named. Failing
   *   work that actually succeeded is the worse error (the standing guidance on
   *   `deriveCodeDiffScorer`).
   * - The ledger write is best-effort and never breaks a run, matching
   *   `recordQaEvidence`. The gate decision itself does NOT depend on it.
   */
  private async assertStageEvidence(args: {
    sessionId: string;
    pipelineId: string;
    stageName: string;
    declared: StageDeclaration | undefined;
    counters: SideEffectCounters | null;
    /** Workspace state captured before the stage ran — see `snapshotStage`. */
    before?: WorkspaceSnapshot | null;
    /** Root the stage's worker writes to, re-walked here for the "after" side. */
    workspaceRoot?: string | null;
  }): Promise<void> {
    const declared: StageDeclaration = {
      producesArtifacts: args.declared?.producesArtifacts,
      runsCommands: args.declared?.runsCommands,
    };
    if (!declared.producesArtifacts && !declared.runsCommands) return;

    const { counters, stageName, pipelineId } = args;
    const measured = counters !== null;

    // The "after" side of the snapshot. Taken here rather than at the call site
    // so it is impossible to gate on a stale reading: this runs immediately
    // before the decision that uses it.
    const after =
      args.before && args.workspaceRoot ? await snapshotWorkspace(args.workspaceRoot) : null;
    const filesTouched = countChangedFiles(args.before ?? null, after);

    const failure = stageEvidenceFailure(declared, counters, filesTouched);
    const passed = failure === null;

    try {
      await verificationEvidenceRepository.record({
        sessionId: args.sessionId,
        pipelineId,
        stage: stageName,
        kind: 'side_effect',
        passed,
        detail: {
          // Recorded even when null, so a later reader can tell "the snapshot
          // said nothing changed" from "there was no snapshot" — the two reasons
          // a counters-only failure can happen.
          filesTouched,
          ...(measured
            ? {
                filesChanged: counters.filesChanged,
                toolCalls: counters.toolCalls,
                commandsRun: counters.commandsRun,
                toolErrors: counters.toolErrors,
                byName: counters.byName,
              }
            : { unavailable: 'worker exposed no side-effect counters — not gated' }),
        },
      });
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message, pipelineId, stage: stageName }, 'Failed to record side-effect verification evidence');
    }

    if (!measured) {
      // The snapshot can still have seen the work even when the worker exposed
      // no tally (a CLI worker). That is a measured pass, not an ungated one —
      // worth distinguishing in the log, because "ungated" is a gap to fix and
      // this is not.
      if (filesTouched !== null && filesTouched > 0) {
        coreLogger.info(
          { pipelineId, stage: stageName, filesTouched },
          'Stage exposed no counters, but the workspace shows its work — passing on filesystem evidence',
        );
      } else {
        coreLogger.warn(
          { pipelineId, stage: stageName, filesTouched },
          'Stage made a declaration but its worker exposed no counters — passing ungated (unknown is not zero)',
        );
      }
      return;
    }

    if (failure) {
      throw new Error(
        `Stage "${stageName}" did not do what it declared: ${failure}. ` +
          `Reporting it complete would claim work that did not happen.`,
      );
    }
  }

  /**
   * The workspace root this session's stage workers actually write to.
   *
   * `WorkspaceFS.forSession` is the shared resolver — a dev-mode session with a
   * `projectPath` runs its agents inside that project, everyone else gets the
   * per-user nested workspace. Reused rather than reimplemented so the gate can
   * never snapshot a different directory than the one the worker wrote to; a
   * mismatch would report "workspace unchanged" for every stage.
   *
   * Resolved once per pipeline run: it cannot change mid-run, and the session
   * lookup is a DB round-trip we do not need per stage.
   */
  private async resolveWorkspaceRoot(sessionId: string): Promise<string | null> {
    try {
      const session = await sessionRepository.findById(sessionId);
      if (!session) return null;
      return WorkspaceFS.forSession(session).root;
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message, sessionId }, 'Could not resolve workspace root for the evidence gate');
      return null;
    }
  }

  /**
   * The "before" half of a stage's filesystem evidence.
   *
   * Only walks the tree for a stage that DECLARED it produces artifacts —
   * everything else is not gated, so the scan would be pure cost.
   */
  private async snapshotStage(
    producesArtifacts: boolean | undefined,
    workspaceRoot: string | null,
  ): Promise<WorkspaceSnapshot | null> {
    if (!producesArtifacts || !workspaceRoot) return null;
    return snapshotWorkspace(workspaceRoot);
  }

  /**
   * Parse a QA/review stage's output and hold its verdict to account.
   *
   * Wraps `parseQAResult` so every verdict — both run loops, both the initial
   * pass and each retry — goes through one chokepoint. A PASSING verdict that
   * cannot account for the stages it covered (`auditVerdictFailure`) is
   * downgraded to a failure carrying the gate's reason, which puts it on the
   * existing retry path instead of turning the pipeline green.
   *
   * `scope` is the artifact-producing stages completed before this auditor,
   * derived from the DECLARED `producesArtifacts` flag rather than inferred
   * from stage names — same discipline as `stageEvidenceFailure`.
   *
   * Returns null when the output carried no parseable verdict at all; callers
   * already treat that as "no QA signal" and skip the retry loop.
   */
  private async gateQaVerdict(
    output: string,
    scope: AuditScopeStage[],
    evidence: { sessionId: string; pipelineId: string; stageName: string },
  ): Promise<QAValidationResult | null> {
    const parsed = this.parseQAResult(output);
    if (!parsed) return null;

    void this.recordQaEvidence(evidence.sessionId, evidence.pipelineId, evidence.stageName, parsed);

    const failure = auditVerdictFailure(parsed, scope);
    if (!parsed.passed) return parsed;

    try {
      await verificationEvidenceRepository.record({
        sessionId: evidence.sessionId,
        pipelineId: evidence.pipelineId,
        stage: evidence.stageName,
        kind: 'audit_coverage',
        passed: failure === null,
        confidence: parsed.confidence ?? null,
        detail: {
          scope: coverageScope(scope).map((s) => s.name),
          doubtScope: scope.filter((s) => s.confidence === 'low').map((s) => s.name),
          uncovered: uncoveredStages(parsed, coverageScope(scope)),
          unaddressedDoubt: unaddressedDoubt(parsed, scope),
          source: parsed.source ?? 'unknown',
          whatIDidNotCheck: parsed.whatIDidNotCheck ?? [],
          ...(failure ? { reason: failure } : {}),
        },
      });
    } catch (err) {
      coreLogger.warn(
        { err: (err as Error).message, pipelineId: evidence.pipelineId, stage: evidence.stageName },
        'Failed to record audit-coverage verification evidence',
      );
    }

    if (!failure) {
      // No silent caps: a pass that never went through the structured tier was
      // exempt from the thin-verdict rules. Say so, rather than let a degraded
      // parse read as a fully-gated pass.
      if (parsed.source !== 'json') {
        coreLogger.warn(
          { pipelineId: evidence.pipelineId, stage: evidence.stageName, source: parsed.source ?? 'unknown' },
          'Audit gate passed a verdict that never reached the structured tier — thin-verdict rules did not apply',
        );
      }
      return parsed;
    }

    coreLogger.warn(
      { pipelineId: evidence.pipelineId, stage: evidence.stageName, failure },
      'Audit-coverage gate rejected a passing verdict — re-running the auditor',
    );
    return {
      ...parsed,
      passed: false,
      auditGateFailed: true,
      feedback: `Your PASS verdict was rejected: ${failure}\n\n${parsed.feedback}`.trim(),
      issues: [...parsed.issues, failure],
    };
  }

  private async recordQaEvidence(
    sessionId: string,
    pipelineId: string,
    stage: string,
    qaResult: QAValidationResult,
  ): Promise<void> {
    try {
      await verificationEvidenceRepository.record({
        sessionId,
        pipelineId,
        stage,
        kind: 'qa_verdict',
        passed: qaResult.passed,
        confidence: qaResult.confidence ?? null,
        detail: { issues: qaResult.issues, feedback: qaResult.feedback, retryCount: qaResult.retryCount },
      });
    } catch (err) {
      coreLogger.warn({ err: (err as Error).message, pipelineId, stage }, 'Failed to record QA verification evidence');
    }
  }

  private parseQAResult(output: string): QAValidationResult | null {
    // (1) Strict JSON parse. Scan EVERY fenced block (plus the bare-string
    // fallback) and take the first that yields an object with a boolean
    // `passed` — a QA/code-review report often has a code block ABOVE its
    // verdict, so matching only the first fence would parse the wrong block.
    const candidates: string[] = [];
    for (const m of output.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?```/g)) {
      candidates.push(m[1].trim());
    }
    candidates.push(output.trim()); // whole output, when the model emitted bare JSON
    for (const jsonStr of candidates) {
      try {
        const parsed = JSON.parse(jsonStr);
        if (typeof parsed.passed === 'boolean') {
          return {
            passed: parsed.passed,
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            feedback: typeof parsed.feedback === 'string' ? parsed.feedback : '',
            retryCount: typeof parsed.retryCount === 'number' ? parsed.retryCount : 0,
            confidence: normalizeConfidence(parsed.confidence),
            whatIDidNotCheck: normalizeStringList(parsed.whatIDidNotCheck),
            source: 'json',
          };
        }
      } catch { /* try the next candidate */ }
    }

    // (2) Inline `"passed": true|false` anywhere in prose
    const passedMatch = output.match(/"passed"\s*:\s*(true|false)/);
    if (passedMatch) {
      const passed = passedMatch[1] === 'true';
      const issuesMatch = output.match(/"issues"\s*:\s*\[([\s\S]*?)\]/);
      const feedbackMatch = output.match(/"feedback"\s*:\s*"([\s\S]*?)"/);
      return {
        passed,
        issues: issuesMatch
          ? issuesMatch[1].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
          : [],
        // Same reason as the prose tier: an empty `feedback` gives the
        // audit-coverage gate nothing to match, so a verdict whose feedback
        // field did not parse falls back to the report itself rather than to
        // an empty string that would read as "named nothing".
        feedback: feedbackMatch ? feedbackMatch[1] : output.slice(0, 2000),
        retryCount: 0,
        confidence: parseConfidence(output),
        source: 'inline',
      };
    }

    // (3) Prose verdict patterns — matches the wording the built-in
    //     templates ask the QA / Code Review agents to emit.
    const proseVerdict = this.parseProseVerdict(output);
    if (proseVerdict) return proseVerdict;

    coreLogger.debug({ outputSnippet: output.slice(0, 200) }, 'Could not parse QA validation output (no JSON, no prose verdict)');
    return null;
  }

  /**
   * Extract pass/fail verdict from prose. Returns null if no recognizable
   * verdict was found. Failing verdicts capture an issues list from common
   * markdown headings (`## Issues`, `### Issues`, `**Issues:**`, etc.) so
   * the retry prompt has actionable feedback to inject into the
   * implementation stage.
   */
  private parseProseVerdict(output: string): QAValidationResult | null {
    // Negative verdicts win over positive — a stage that says "mostly good
    // but FAIL on X" should retry, not pass.
    const NEGATIVE_PATTERNS = [
      /Overall\s+status\s*:\s*FAIL\b/i,
      /Overall\s+status\s*:\s*PASS\s+WITH\s+NOTES\b/i, // treat as failure → retry
      /Rate\s+overall\s+quality\s*:\s*(?:Needs\s+Work|Critical\s+Issues)\b/i,
      /Overall\s+quality\s*:\s*(?:Needs\s+Work|Critical\s+Issues)\b/i,
      /\bVerdict\s*:\s*(?:fail|reject|not\s+ready)\b/i,
      /^[#*\s]*FAIL\b/im,
    ];
    const POSITIVE_PATTERNS = [
      /Overall\s+status\s*:\s*PASS\b(?!\s+WITH\s+NOTES)/i,
      /Rate\s+overall\s+quality\s*:\s*(?:Excellent|Good)\b/i,
      /Overall\s+quality\s*:\s*(?:Excellent|Good)\b/i,
      /\bVerdict\s*:\s*(?:pass|approve|ready)\b/i,
      /^[#*\s]*PASS\b/im,
    ];

    const hasNegative = NEGATIVE_PATTERNS.some(rx => rx.test(output));
    const hasPositive = POSITIVE_PATTERNS.some(rx => rx.test(output));

    if (!hasNegative && !hasPositive) return null;

    const passed = hasNegative ? false : true;

    // Pull an issues bullet list from common heading shapes if the verdict
    // is negative — gives the retry prompt something concrete to act on.
    let issues: string[] = [];
    if (!passed) {
      const issuesSection = output.match(
        /(?:^|\n)\s*(?:#{1,4}\s+|\*\*)\s*(?:Issues\s+found|Issues|Critical\s+Issues|Problems|Findings)\b[^\n]*\n([\s\S]*?)(?=\n\s*(?:#{1,4}\s+|\*\*[A-Z])|\n\s*$|$)/i,
      );
      if (issuesSection) {
        issues = issuesSection[1]
          .split('\n')
          .map(line => line.replace(/^\s*[-*•]\s*/, '').trim())
          .filter(line => line.length > 0 && !line.startsWith('#'))
          .slice(0, 20);
      }
    }

    return {
      passed,
      issues,
      // The prose report IS the verdict's reasoning, on a pass as much as on a
      // failure. It used to be dropped for a pass (nothing read it), but the
      // audit-coverage gate matches the audited stage names against `feedback`
      // — blanking it here would reject every honest prose audit for naming
      // nothing, the one outcome worse than no gate.
      feedback: output.slice(0, 2000),
      retryCount: 0,
      confidence: parseConfidence(output),
      source: 'prose',
    };
  }

  private async updatePipeline(id: string, data: Partial<NewPipeline>) {
    await this.db
      .update(pipelines)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(pipelines.id, id));
  }

  private async updateStage(id: string, data: Partial<NewPipelineStage>) {
    await this.db
      .update(pipelineStages)
      .set(data)
      .where(eq(pipelineStages.id, id));
  }
}

// Singleton
let instance: PipelineManager | null = null;

export function getPipelineManager(): PipelineManager {
  if (!instance) {
    instance = new PipelineManager();
  }
  return instance;
}

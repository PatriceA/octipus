import { resolve } from 'path';
import { getConfig } from '@/config';
import { getAgentManager } from '@/core/agent-manager';
import { getGatewayHub } from '@/core/gateway/hub';
import { getNotificationService } from '@/core/notification-service';
import { swarmNodeRepository } from '@/core/swarm/node-repository';
import { taskFingerprint } from '@/core/swarm/spawner';
import { createSpawnChildTool } from '@/core/swarm/swarm-tool';
import { type AgentNode, getLevelDefault } from '@/core/swarm/types';
import type { AgentContext } from '@/core/types';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { ProfileFact } from '@/db/schema/profiles';
import { getModelRegistry } from '@/models/model-registry';
import { WorkspaceFS } from '@/security/workspace-fs';
import { coreLogger } from '@/utils/logger';
import { loadAgentsMd } from './agents-md';
import { buildSecurityReminder } from './input-guard';
import type { ModelSelector } from './model-selector';
import { buildOutputDirective } from './output-directive';
import { getBoundConnectorIds, getRoleConfig, getToolsForRole, SECURITY_PREAMBLE, stripSecurityPreamble } from './roles';
import { applyToolCap, isSmallModel } from './small-model';
import type { OrchestratorEvent } from './service';
import { appendSources } from './types';
import type { AgentRole, WorkerResult } from './types';
import { formatDateTimeContext } from '@/utils/date-context';

/**
 * Optional swarm wiring for `spawnWorker`. When provided, the worker is
 * registered as a depth-1 agent node under the supplied parent (typically
 * the orchestrator), so it shows up in the swarm tree UI, and is given the
 * `spawn_child` meta-tool so it can fan out to subagents like any other
 * agent in the swarm. Used by pipeline stages — without this, stages run
 * invisibly to the swarm view and cannot delegate further.
 */
export interface WorkerSwarmParent {
  id: string;
  rootSessionId: string;
  topicPath: string;
  subtopic?: string;
}

type EmitFn = (event: OrchestratorEvent) => void;

export interface WorkerSpawnerDeps {
  modelSelector: ModelSelector;
  emit: EmitFn;
  setLastWorkerResult: (result: string | null) => void;
}

/**
 * Spawn an expert-based worker directly (skip classification + orchestrator).
 */
export async function handleExpertMessage(
  expertId: string,
  message: string,
  sessionId: string,
  userId: string,
  deps: WorkerSpawnerDeps,
  guardFlags: string[] = [],
  workspaceId: string | null = null,
  /**
   * Pre-rendered edit-and-continue context (current contents of files the user
   * attached to this turn), appended to the expert's system prompt so a
   * preset-selected turn still operates on the live file — design Thread 2.
   */
  attachedFilesBlock = '',
  /** Chat/work split (Thread 3): inline vs file deliverable directive. */
  outputDirective: { mode: 'inline' | 'file'; forced: boolean } = { mode: 'inline', forced: false },
): Promise<{ response: string; sessionId: string; classification: import('./types').MessageClassification; metadata?: import('./types').ResponseMetadata }> {
  const { getDb } = await import('@/db/postgres');
  const db = getDb();
  const { experts } = await import('@/db/schema/experts');
  const { eq } = await import('drizzle-orm');

  const [expert] = await db.select().from(experts).where(eq(experts.id, expertId)).limit(1);
  if (!expert) {
    return {
      response: `Expert not found: ${expertId}`,
      sessionId,
      classification: { type: 'task', confidence: 1, complexity: 'simple' },
    };
  }

  const startTime = Date.now();
  const agentRole = expert.role as AgentRole;
  const roleConfig = getRoleConfig(agentRole);
  // Model lane: the expert's assigned topic (see experts.topic), falling back
  // to the role default for pre-consolidation rows.
  const expertLane = expert.topic || roleConfig.defaultTopic;
  const context: AgentContext = {
    id: `expert-${Date.now()}`,
    sessionId,
    userId,
    workspaceId,
    model: expert.modelPreference || '',
    topic: expertLane,
    role: agentRole,
    status: 'running',
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: { expertId, isExpert: true },
  };

  await messageRepository.create({ sessionId, role: 'user', content: message });
  await sessionRepository.incrementMessageCount(sessionId);

  // Small-model tier for this expert's worker. spawnWorker handles the tool cap
  // and MCP-guidance skip for any worker, but the deliverable/metrics/response
  // scaffold below is assembled here and passed as a systemPrompt override, so
  // it must be trimmed here too. Tier is the expert's modelPreference if set,
  // else the role's topic model — matching what spawnWorker will actually run.
  const orchCfg = getConfig().orchestrator;
  let isSmall = false;
  try {
    const registry = getModelRegistry();
    const tierModel = expert.modelPreference
      ? await registry.getModelByModelId(expert.modelPreference)
      : await registry.getModelForTopic(expertLane);
    if (tierModel) {
      isSmall = isSmallModel({ modelId: tierModel.modelId, metadata: tierModel.metadata }, orchCfg.routerSmallModelMaxParams);
    }
  } catch (err) {
    coreLogger.debug({ err, expertId, role: agentRole }, 'expert small-model tier check skipped (non-fatal)');
  }

  try {
    // Build expert identity prompt — role config as base, then expert-specific overrides
    let expertPrompt = SECURITY_PREAMBLE;

    // Expert identity: name, description, and role-specific system prompt.
    // Strip a leading SECURITY_PREAMBLE from the concatenated body — both
    // `expert.systemPrompt` (legacy expert rows seeded with the preamble
    // baked in) and `roleConfig.systemPromptTemplate` (always prepended by
    // getRoleConfig) can carry it, which would duplicate the block above.
    expertPrompt += `\nYou are **${expert.name}**${expert.description ? ` — ${expert.description}` : ''}.\n\n`;
    expertPrompt += stripSecurityPreamble(expert.systemPrompt || roleConfig.systemPromptTemplate);

    // Critical rules
    const criticalRules = (expert.criticalRules as string[]) || [];
    if (criticalRules.length > 0) {
      expertPrompt += '\n\n# Critical Rules\nYou MUST follow these rules:\n' +
        criticalRules.map((r, i) => `${i + 1}. ${r}`).join('\n');
    }

    // Deliverable template + success metrics: quality scaffolding for larger
    // models, prompt bloat that weak models follow poorly. Skip in the small tier.
    if (expert.deliverableTemplate && !isSmall) {
      expertPrompt += '\n\n# Deliverable Template\nStructure your output as follows:\n' + expert.deliverableTemplate;
    }

    const successMetrics = (expert.successMetrics as string[]) || [];
    if (successMetrics.length > 0 && !isSmall) {
      expertPrompt += '\n\n# Success Metrics\nYour output will be evaluated against these criteria:\n' +
        successMetrics.map((m, i) => `${i + 1}. ${m}`).join('\n');
    }

    // Expert-specific tool guidance — prevents looping and over-engineering.
    // Small models get a compact version (the long form's nuances are lost on
    // them and cost ~180 tokens better spent on the task).
    if (isSmall) {
      expertPrompt += '\n\n# Response Guidelines\n'
        + '- Greetings / "what can you do": reply in plain text, no tools.\n'
        + '- Use a tool only when the task needs external data, files, or actions; otherwise answer directly.\n'
        + '- Never repeat a tool call with identical arguments. After at most 5 tool calls, stop and answer.';
    } else {
      expertPrompt += '\n\n# Response Guidelines\n'
        + '- For conversational messages (greetings, "what can you do", introductions): respond directly with text. Do NOT call any tools.\n'
        + '- Only use tools when the task genuinely requires external data, file operations, or actions.\n'
        + '- Think step-by-step before deciding whether to use a tool. If you can answer from your domain knowledge, do so directly.\n'
        + '- Never call the same tool twice with identical arguments.\n'
        + '- After at most 5 tool calls, synthesize your findings and respond.\n'
        + '- PREFER built-in tools over writing code/scripts. For recurring tasks use the scheduling tool (create_hook). For notifications use the messaging tool (send_message). Do NOT create standalone scripts, plugins, or services when a built-in tool exists.';
    }

    if (guardFlags.length > 0) {
      expertPrompt += buildSecurityReminder(guardFlags);
    }

    // Edit-and-continue: live contents of files attached to this turn.
    if (attachedFilesBlock) {
      expertPrompt += attachedFilesBlock;
    }

    // Chat/work split (Thread 3): deliver inline vs as a file.
    expertPrompt += buildOutputDirective(outputDirective.mode, outputDirective.forced);

    // Domain knowledge from skills
    const skillIds = (expert.skillIds as string[]) || [];
    if (skillIds.length > 0) {
      const { getSkillRegistry } = await import('@/skills/registry');
      const skillReg = getSkillRegistry();
      const found = await skillReg.getByIds(skillIds);
      if (found.length < skillIds.length) {
        const foundSet = new Set(found.map((s) => s.id));
        const missing = skillIds.filter((id) => !foundSet.has(id));
        coreLogger.error(
          { expertId, expertName: expert.name, expectedSkillIds: skillIds, missing },
          'Expert lists skillIds missing from registry — expert worker runs with partial domain knowledge',
        );
      }
      // Small tier: inject the index (name + 1-line description) instead of the
      // full skill bodies — multi-skill experts otherwise dump tens of k tokens
      // a small model can't use. Larger models get the full fragment here: a
      // direct `/expert` invocation is an explicit, focused request, so we keep
      // full fidelity (unlike auto-spawned experts in spawnWorker, which always
      // use the index because the orchestrator may fan out to several).
      if (isSmall) {
        const summary = await skillReg.buildPromptSummary(skillIds);
        if (summary) expertPrompt += `\n\n# Domain Knowledge (index)\n${summary}`;
      } else {
        const fragment = await skillReg.buildPromptFragment(skillIds);
        if (fragment) expertPrompt += `\n\n# Domain Knowledge\n${fragment}`;
      }
    }

    const result = await spawnWorker(agentRole, message, '', context, deps, {
      systemPrompt: expertPrompt,
      model: expert.modelPreference || undefined,
      topic: expertLane,
    });

    // Source attribution: which expert ran, which role, which skills were
    // injected. Mirrors the directResponse / orchestrator footer so the
    // user sees consistent provenance no matter which path served them.
    const sources: string[] = [`expert(${expert.name})`, `role(${agentRole})`];
    if (skillIds.length > 0) sources.push(`skills(${skillIds.length})`);
    if (guardFlags.length > 0) sources.push(`guard(${guardFlags.join(',')})`);

    const session = await sessionRepository.findById(sessionId);
    const showSources = (session?.metadata as Record<string, unknown> | undefined)?.showSources !== false;
    const response = showSources ? appendSources(String(result), sources) : String(result);

    await messageRepository.create({ sessionId, role: 'assistant', content: response });
    await sessionRepository.incrementMessageCount(sessionId);

    return {
      response,
      sessionId,
      classification: { type: 'task', confidence: 1, complexity: 'moderate', topic: expert.role },
      metadata: { latencyMs: Date.now() - startTime, sources },
    };
  } catch (error) {
    const errMsg = (error as Error).message || '';
    coreLogger.error({ error, expertId, role: agentRole }, 'Expert worker failed');

    // Permission denial or user abort → friendly message, let user decide next step
    if (errMsg.includes('Permission denied') || errMsg.includes('stopped by user') || errMsg.includes('aborted')) {
      const response = `The agent was stopped because a required action was denied.\n\nOriginal request: "${message.slice(0, 200)}"\n\nWould you like me to try a different approach, or is there something else I can help with?`;
      await messageRepository.create({ sessionId, role: 'assistant', content: response });
      return {
        response,
        sessionId,
        classification: { type: 'task', confidence: 1, topic: expert.role },
        metadata: { latencyMs: Date.now() - startTime },
      };
    }

    return {
      response: `Expert worker failed: ${errMsg}`,
      sessionId,
      classification: { type: 'task', confidence: 1 },
    };
  }
}

/**
 * Spawn a single worker agent for a given role and task.
 */
export async function spawnWorker(
  role: string,
  task: string,
  input: string,
  context: AgentContext,
  deps: WorkerSpawnerDeps,
  overrides?: { systemPrompt?: string; model?: string; topic?: string; swarmParent?: WorkerSwarmParent },
): Promise<unknown> {
  const agentManager = getAgentManager();
  const agentRole = role as AgentRole;
  const roleConfig = getRoleConfig(agentRole);
  let roleTools = getToolsForRole(agentRole);

  if (context.userId && context.userId !== 'system' && context.userId !== 'local') {
    try {
      const { getConnectorRegistry } = await import('@/connectors');
      // Role↔connector binding: if the role binds specific connectors
      // (`connector:<id>` in its toolIds), expose only those; otherwise expose
      // all of the user's active connectors (backward-compatible default).
      const boundConnectorIds = getBoundConnectorIds(agentRole);
      const allowed = boundConnectorIds.length > 0 ? new Set(boundConnectorIds) : undefined;
      const connectorHandlers = await getConnectorRegistry().getUserToolHandlers(context.userId, allowed);
      roleTools.push(...connectorHandlers);
    } catch (err) {
      coreLogger.warn({ err, userId: context.userId }, 'Failed to load connector tool handlers');
    }
  }

  coreLogger.info({ role: agentRole, toolCount: roleTools.length, toolNames: roleTools.map(t => t.name) }, 'Worker tools resolved');

  // Fail-loud (house rule #1): a TOOLLESS worker would otherwise spawn
  // silently. The empty set can come from a deliberate customization (PATCH
  // /roles + tool_ids_customized=true so loadRolesFromDb no longer merges code
  // defaults — an intended capability we do NOT auto-restore) OR from every
  // tool being gated out by missing capabilities / unregistered ids. We can't
  // discriminate synchronously here, so the message names all causes rather
  // than blaming customization — surface it so operators can spot the gap.
  if (roleTools.length === 0) {
    coreLogger.warn(
      { role: agentRole },
      `Worker role "${agentRole}" resolved to ZERO tools (deliberate customization, capability gating, or unregistered ids); this worker will spawn toolless`,
    );
  }

  // Auto-select the role's system expert ROW first — its assigned model lane
  // (`experts.topic`) decides which topic binding resolves the model, so it
  // must be known before routing. Prompt assembly from the row happens further
  // down, once the model tier (isSmall) is known.
  let matchingExpert: import('@/db/schema/experts').Expert | null = null;
  if (!overrides?.systemPrompt) {
    try {
      const { getDb } = await import('@/db/postgres');
      const { experts } = await import('@/db/schema/experts');
      const { eq, and } = await import('drizzle-orm');
      const db = getDb();
      const [row] = await db.select().from(experts)
        .where(and(eq(experts.role, agentRole), eq(experts.isSystem, true)))
        .limit(1);
      matchingExpert = row ?? null;
    } catch (err) {
      coreLogger.debug({ err, role: agentRole }, 'Expert auto-selection skipped');
    }
  }

  // Model lane: explicit override (expert direct-invocation path) > the
  // auto-selected expert's lane > the role default (canonicalizes to 'agents').
  const lane = overrides?.topic || matchingExpert?.topic || roleConfig.defaultTopic;

  // Resolve the worker's model up front so we know whether it's in the small
  // (router) tier before assembling the prompt. The orchestrator already
  // shrinks itself for small models (router/lite/full); this is the mirror
  // image for workers — trim the expert scaffold and cap the tool surface so a
  // weak local model isn't handed a 14-tool list and a multi-section prompt it
  // can't drive. Smallness is derived from the *lane* model (what runs in the
  // single-model / router case); an explicit expert modelPreference is a rare
  // override and still benefits from a leaner prompt.
  const routing = await deps.modelSelector.selectForWorker(
    lane,
    roleTools.length > 0,
  );
  const orchCfg = getConfig().orchestrator;
  let isSmall = false;
  if (routing.model) {
    try {
      const topicMeta = await getModelRegistry().getModelByModelId(routing.model);
      isSmall = isSmallModel({ modelId: routing.model, metadata: topicMeta?.metadata }, orchCfg.routerSmallModelMaxParams);
    } catch (err) {
      coreLogger.debug({ err, model: routing.model }, 'small-model tier check skipped (non-fatal)');
    }
  }
  if (isSmall) {
    coreLogger.info({ role: agentRole, model: routing.model }, 'Worker model is small-tier — trimming prompt + tools');
  }

  // Assemble the auto-selected expert's prompt scaffold (row fetched above,
  // before routing, so the expert's lane could steer model resolution).
  let expertPrompt: string | undefined;
  let expertModel: string | undefined;
  // Hoisted so the topic-skill dedupe below can read whichever skillIds
  // the matched expert advertised. Closed over by the topic-skill block.
  let expertSkillIdsOuter: string[] = [];
  {
    try {
      if (matchingExpert) {
        expertPrompt = matchingExpert.systemPrompt || undefined;
        expertModel = matchingExpert.modelPreference || undefined;

        const criticalRules = (matchingExpert.criticalRules as string[]) || [];
        if (criticalRules.length > 0) {
          expertPrompt = (expertPrompt || '') + '\n\n# Critical Rules\nYou MUST follow these rules:\n' +
            criticalRules.map((r, i) => `${i + 1}. ${r}`).join('\n');
        }

        // Deliverable template + success metrics are quality scaffolding that
        // helps larger models structure output but bloats the prompt for small
        // ones (and weak models follow them poorly anyway). Skip both in the
        // small tier; critical rules stay because they're short and behavioral.
        const deliverableTemplate = matchingExpert.deliverableTemplate;
        if (deliverableTemplate && !isSmall) {
          expertPrompt = (expertPrompt || '') + '\n\n# Deliverable Template\nStructure your output as follows:\n' + deliverableTemplate;
        }

        const successMetrics = (matchingExpert.successMetrics as string[]) || [];
        if (successMetrics.length > 0 && !isSmall) {
          expertPrompt = (expertPrompt || '') + '\n\n# Success Metrics\nYour output will be evaluated against these criteria:\n' +
            successMetrics.map((m, i) => `${i + 1}. ${m}`).join('\n');
        }

        const skillIds = (matchingExpert.skillIds as string[]) || [];
        expertSkillIdsOuter = skillIds;
        if (skillIds.length > 0) {
          const { getSkillRegistry } = await import('@/skills/registry');
          const skillReg = getSkillRegistry();
          const found = await skillReg.getByIds(skillIds);
          if (found.length < skillIds.length) {
            const foundSet = new Set(found.map((s) => s.id));
            const missing = skillIds.filter((id) => !foundSet.has(id));
            coreLogger.error(
              { role: agentRole, expert: matchingExpert.name, expectedSkillIds: skillIds, missing },
              'Expert lists skillIds missing from registry — worker runs with partial domain knowledge',
            );
          }
          // Index-only mode: dump skill name + 1-line description, not
          // the whole body. The agent loads specific skill content via
          // the built-in `get_skill` tool when it needs to. A typical
          // role with 30+ skills was previously dumping ~50–80k tokens
          // of skill bodies into every worker prompt; now it's a few
          // hundred and the agent pays only for what it pulls.
          const summary = await skillReg.buildPromptSummary(skillIds);
          if (summary) {
            expertPrompt = `${expertPrompt || ''}\n\n# Domain Knowledge (index)\n${summary}`;
          }
        }

        coreLogger.info(
          { role: agentRole, expert: matchingExpert.name, lane, hasSkills: (matchingExpert.skillIds as string[] || []).length > 0 },
          'Auto-selected expert for worker role',
        );
      }
    } catch (err) {
      coreLogger.debug({ err, role: agentRole }, 'Expert prompt assembly skipped');
    }
  }

  // ── Inject topic-assigned active skills (hybrid discovery) ──
  // Same index-only treatment as expert skills above. Dedupe against
  // the expert's skillIds so an overlap doesn't list the same skill
  // twice — previously the prompt carried two copies of every shared
  // skill, doubling that part of the token cost for no benefit.
  let topicSkillFragment = '';
  try {
    const { discoverSkillIds } = await import('@/skills/discovery');
    const { getSkillRegistry } = await import('@/skills/registry');
    // Skill assignments stay ROLE-keyed ('coding', 'research', …) after the
    // topic consolidation — the model lane ('agents') says nothing about which
    // domain skills fit, the role does.
    const discoveredIds = await discoverSkillIds({
      topic: agentRole,
      message: task,
    });
    const expertSkillIds = new Set<string>(expertSkillIdsOuter);
    const noveltopicIds = discoveredIds.filter((id) => !expertSkillIds.has(id));
    if (noveltopicIds.length > 0) {
      topicSkillFragment = await getSkillRegistry().buildPromptSummary(noveltopicIds);
    }
    coreLogger.debug(
      {
        topic: agentRole,
        discoveredSkillCount: discoveredIds.length,
        afterDedupe: noveltopicIds.length,
      },
      'Injected topic-assigned skills',
    );
  } catch (err) {
    // Fail loud: topic-skill injection shouldn't throw under normal
    // operation. Previously debug-level — promoted to error so misconfigs
    // (e.g. DB offline, schema drift) surface in logs.
    coreLogger.error(
      { err, topic: agentRole },
      'Topic skill injection failed — worker runs WITHOUT topic skills',
    );
  }

  const finalModel = overrides?.model || expertModel || routing.model;
  if (!finalModel) {
    return { error: 'No model configured. Please add one in the Models page.' };
  }

  // Small-tier worker: cap the tool surface. Role tool lists are
  // priority-ordered so the core tools survive; the long tail (and MCP
  // meta-tools / connector handlers appended above) is dropped. Skipped for
  // larger models, which keep the full surface.
  if (isSmall) {
    roleTools = applyToolCap(roleTools, orchCfg.smallModelMaxTools, { role: agentRole, modelId: finalModel });
  }

  const startTime = Date.now();

  let systemPrompt = overrides?.systemPrompt || expertPrompt || roleConfig.systemPromptTemplate;

  // Append topic-assigned skills (e.g. caveman mode) after the base prompt
  if (topicSkillFragment) {
    systemPrompt += '\n\n# Topic Skills\n' + topicSkillFragment;
  }

  // Inject current date/time context so agents know "today"
  systemPrompt += `\n\nCURRENT DATE/TIME: ${formatDateTimeContext(new Date())}`;
  // Determine if this is a dev mode session
  const session = await sessionRepository.findById(context.sessionId);
  const sessionCtx = session?.context as import('@/db/schema/sessions').SessionContext | undefined;
  const isDevMode = sessionCtx?.devMode === true && !!sessionCtx.projectPath;
  const devProjectPath = isDevMode ? sessionCtx!.projectPath! : undefined;

  // Inject the curated AGENTS.md guide and maintenance instruction.
  // AGENTS.md (https://agents.md) is the universal project guide other agent
  // tools also honour, so a single curated file serves every agent.
  const AGENTS_MD_INSTRUCTION = `\n\nPROJECT GUIDE — AGENTS.md:
Each repository carries a curated AGENTS.md at its root (the universal agent guide). Before working in a repo, read its AGENTS.md to understand structure, stack, key files, and commands. In a multi-repo workspace, read the AGENTS.md of EACH repo you touch.
Treat AGENTS.md as a curated guide, not a changelog: keep it concise and durable (structure, entry points, frameworks, key files, build/test/lint/run commands, conventions). Update it ONLY when you learn something structurally important that future agents need — never dump raw task output or per-run history into it (run history is tracked separately).
If a repo has no AGENTS.md and you have mapped it out, you may create one at its root.`;

  // The curated guide applies to dev-mode sessions (explicit project link).
  // Non-dev sessions read per-repo AGENTS.md on demand via the instruction above.
  if (devProjectPath) {
    context.metadata.projectPath = devProjectPath;
    systemPrompt += AGENTS_MD_INSTRUCTION;
    const agentsGuide = await loadAgentsMd(devProjectPath);
    if (agentsGuide) {
      const projectName = sessionCtx?.projectName || devProjectPath.split(/[/\\]/).pop() || 'project';
      systemPrompt += `\n\n--- AGENTS.md (${projectName}) ---\n${agentsGuide}`;
    }
  } else {
    systemPrompt += AGENTS_MD_INSTRUCTION;
  }

  // Inject git status/diff for code-aware roles (gives agents awareness of pending changes)
  const GIT_AWARE_ROLES = new Set(['coding', 'review', 'devops', 'security', 'qa']);
  if (GIT_AWARE_ROLES.has(agentRole)) {
    try {
      const { execSync } = await import('child_process');
      const gitCwd = devProjectPath || getConfig().workspace?.rootPath || process.cwd();
      const gitStatus = execSync('git status --short 2>/dev/null | head -20', { cwd: gitCwd, timeout: 5_000, encoding: 'utf-8' }).trim();
      const gitDiff = execSync('git diff --stat 2>/dev/null | tail -5', { cwd: gitCwd, timeout: 5_000, encoding: 'utf-8' }).trim();
      if (gitStatus || gitDiff) {
        systemPrompt += '\n\n--- Git Status ---';
        if (gitStatus) systemPrompt += `\n${gitStatus}`;
        if (gitDiff) systemPrompt += `\n\nDiff summary:\n${gitDiff}`;
      }
    } catch { /* not a git repo or git unavailable */ }
  }

  // Inject user profile context + related profiles for people-related queries
  if (context.userId) {
    try {
      const { ProfileRepository } = await import('@/db/repositories/profile-repository');
      const profileRepo = new ProfileRepository();

      // Always inject the user's own profile
      const userProfile = await profileRepo.findUserProfile(context.userId);
      if (userProfile && (userProfile.facts as ProfileFact[])?.length > 0) {
        const facts = (userProfile.facts as ProfileFact[]).map(f => `- ${f.key}: ${f.value}`).join('\n');
        systemPrompt += `\n\nUSER CONTEXT:\nName: ${userProfile.name}\n${facts}`;
      }

      // For people-related queries, search for relevant profiles and inject matches.
      // CLI agents can't call the profiles tool (registerTool is a no-op), so we
      // resolve profile data here and put it in the prompt context.
      const peoplePatterns = /\b(who is|wife|husband|partner|mother|father|mom|dad|boss|friend|brother|sister|family|birthday|address|phone|email of|tell me about|remember|my dog|my cat|my pet|company|organization)\b/i;
      if (peoplePatterns.test(task)) {
        // Extract search terms — strip common question words to get the relevant noun
        const searchTerms = task
          .replace(/\b(who is|what is|tell me about|what's|do you know about|my)\b/gi, '')
          .trim()
          .split(/\s+/)
          .filter(w => w.length > 2 && !/^(the|and|for|with)$/i.test(w));

        const matchedProfiles = new Map<string, Awaited<ReturnType<typeof profileRepo.search>>[0]>();
        // Search for each meaningful term
        for (const term of searchTerms.slice(0, 3)) {
          const results = await profileRepo.search(context.userId, term);
          for (const p of results) matchedProfiles.set(p.id, p);
        }
        // Also search for relationship keywords directly (wife, husband, etc.)
        const relationshipMatch = task.match(/\b(wife|husband|partner|mother|father|mom|dad|boss|brother|sister|son|daughter)\b/i);
        if (relationshipMatch) {
          const results = await profileRepo.search(context.userId, relationshipMatch[1]);
          for (const p of results) matchedProfiles.set(p.id, p);
        }

        const relevant = [...matchedProfiles.values()].filter(p => p.id !== userProfile?.id).slice(0, 5);
        if (relevant.length > 0) {
          const profileTexts = relevant.map(p => {
            const facts = (p.facts as ProfileFact[]) || [];
            const factsStr = facts.map(f => `  - ${f.key}: ${f.value}`).join('\n');
            return `**${p.name}** (${p.category || 'person'})${p.relationship ? ` — ${p.relationship}` : ''}\n${factsStr}`;
          });
          systemPrompt += `\n\nRELEVANT PROFILES:\n${profileTexts.join('\n\n')}`;
        }
      }
    } catch (err) { coreLogger.error({ err }, 'silent failure in worker-spawner'); }
  }

  // Inject workspace context
  if (isDevMode && devProjectPath) {
    // Dev mode: workspace is the specific project
    let workspaceHint = `\n\nWORKSPACE CONSTRAINT: You are working in the project at ${devProjectPath}.`;
    workspaceHint += ` Focus your work within this directory. Do not browse parent directories or unrelated projects unless the task explicitly requires it.`;
    const octiRoot = resolve(process.cwd());
    if (devProjectPath !== octiRoot) {
      workspaceHint += `\nOCTIPUS PROJECT: ${octiRoot}`;
    }
    workspaceHint += `\nPLUGIN DIRECTORY: ${octiRoot}/extensions/ — ALL plugins MUST be created here, nowhere else.`;
    if (/\s/.test(octiRoot) || /\s/.test(devProjectPath)) {
      workspaceHint += `\nIMPORTANT: Paths contain spaces — ALWAYS wrap them in double quotes in shell commands (e.g. \`chmod +x "${devProjectPath}/file.sh"\`). Unquoted, the shell splits on spaces and the command fails.`;
    }
    systemPrompt += workspaceHint;
  } else {
    // Normal mode: global workspace.
    // Advertise the SAME root the filesystem sandbox enforces. `WorkspaceFS.forAgent`
    // nests every real user under `<rootPath>/users/<uid>/workspaces/default/files`;
    // advertising the flat `config.workspace.rootPath` here pointed agents at a path
    // outside their own sandbox ("outside allowed workspace directories" on absolute
    // calls). `.root` is a pure path computation — no filesystem side effects.
    const config = getConfig();
    const workspaceRoot = WorkspaceFS.forAgent({ userId: context.userId }).root;
    const additionalPaths = config.workspace.additionalPaths?.map((p: string) => resolve(p)).filter(Boolean) || [];
    let workspaceHint = `\n\nWORKSPACE CONSTRAINT: You are working in the project at ${workspaceRoot}.`;
    if (additionalPaths.length > 0) {
      workspaceHint += ` Additional allowed paths: ${additionalPaths.join(', ')}.`;
    }
    workspaceHint += ` Focus your work within these directories. Do not browse parent directories or unrelated projects unless the task explicitly requires it.`;
    const octiRoot = resolve(process.cwd());
    if (workspaceRoot !== octiRoot) {
      workspaceHint += `\nOCTIPUS PROJECT: ${octiRoot}`;
    }
    workspaceHint += `\nPLUGIN DIRECTORY: ${octiRoot}/extensions/ — ALL plugins MUST be created here, nowhere else.`;
    if (/\s/.test(workspaceRoot) || /\s/.test(octiRoot)) {
      workspaceHint += `\nIMPORTANT: Paths contain spaces — ALWAYS wrap them in double quotes in shell commands (e.g. \`chmod +x "${workspaceRoot}/project/file.sh"\`). Unquoted, the shell splits on spaces and the command fails.`;
    }
    systemPrompt += workspaceHint;
  }

  // Memory-redesign Phase D — surface role-scoped long-term memory.
  // Filter is OR(NULL, role) so this also picks up globally-scoped
  // facts. Auto-no-op when the memories table is empty or memory
  // extraction has not been wired by the operator.
  if (context.userId) {
    try {
      const { retrieveForContext, renderMemoriesBlock } = await import('@/core/memory');
      const memRows = await retrieveForContext({
        userId: context.userId,
        agentScope: agentRole,
        limit: 8,
      });
      const memBlock = renderMemoriesBlock(memRows);
      if (memBlock) systemPrompt += memBlock;
    } catch (err) {
      coreLogger.debug({ err, role: agentRole }, 'specialist memory injection skipped (non-fatal)');
    }
  }

  // Workers must return results to the orchestrator, not message the user directly
  systemPrompt += `\n\nIMPORTANT: You are a worker agent. Return your findings and results as plain text in your final response. Do NOT use messaging tools (send_to_user, send_channel_message) to contact the user — the orchestrator handles all user communication. Just do your task and respond with the result.`;

  // Knowledge-tool roles: point them at the auto-indexed product docs so
  // "how do I set up / configure / connect X" questions are answered from
  // the shipped manual instead of a guess. Small models get the leaner
  // surface (they tend to misfire on extra tool guidance).
  if (!isSmall && roleTools.some((t) => t.toolId === 'knowledge')) {
    systemPrompt += `\n\nPRODUCT DOCS: Octipus's own product documentation (setup, channels, model providers, configuration) is indexed in the knowledge base (source "octipus-docs"). For any "how do I set up / configure / connect / enable X" question about Octipus itself, call search_knowledge FIRST and answer from the retrieved docs — cite the source file — rather than guessing.`;
  }

  // Inform CLI agents about the Octipus MCP self-server.
  //
  // This is CLI-ONLY by design: Claude Code / Gemini / Codex run out-of-process
  // and have NO in-process tool registry, so they reach Octipus capabilities
  // (profiles, knowledge, web search, messaging, scheduling, documents) by
  // connecting to the standalone "octipus" MCP server and calling octipus_* tools.
  //
  // In-process LLM agents are different: those same capabilities are already
  // their DIRECT built-in tools (knowledge, websearch, profiles, …), and the
  // in-process MCP bridge only ever connects to the user's *external* MCP
  // servers — never the octipus self-server. The old `else if (!isSmall)` block
  // therefore advertised a server that isn't in their bridge and duplicated tools
  // they already hold (and claimed MCP existed even when no external server was
  // configured and the meta-tools were absent). Removed. LLM agents that have
  // external MCP servers bound still get the self-describing mcp_list_tools /
  // mcp_call_tool handlers — no prompt guidance needed.
  const isCLIModel = finalModel?.startsWith('cli/');
  if (isCLIModel) {
    systemPrompt += `\n\nOCTIPUS MCP TOOLS: You have access to the "octipus" MCP server which provides tools for:
- **People & profiles**: Search/retrieve stored information about people the user knows (octipus_search_profiles, octipus_get_profile)
- **Knowledge base**: Search the user's knowledge base (octipus_search_knowledge)
- **Web search**: Search the web (octipus_search) and fetch pages (octipus_fetch_page)
- **Messaging**: Send messages to the user's channels — Telegram, Slack, etc. (octipus_send_channel_message)
- **Scheduling**: Create/manage scheduled tasks and automations (octipus_create_recurring_task)
- **Documents**: Upload and index documents (octipus_upload_document)
Use these MCP tools when the task benefits from them — especially for people-related questions, knowledge lookups, or cross-channel messaging.`;
  }

  // ── Swarm wiring (pipeline stages) ──────────────────────────────
  // When a parent swarm node is supplied (currently only by pipeline
  // stages), register this worker in the swarm tree and hand it the
  // `spawn_child` meta-tool so it can fan out to subagents. The stage's
  // own AgentNode carries a placeholder id that is mutated to the real
  // worker id once `agentManager.spawn` returns; `createSpawnChildTool`
  // closes over the node by reference, so the tool sees the real id by
  // the time it can be invoked.
  let stageNode: AgentNode | null = null;
  if (overrides?.swarmParent) {
    const lvl = getLevelDefault(1);
    stageNode = {
      id: '__pending__',
      rootSessionId: overrides.swarmParent.rootSessionId,
      parentNodeId: overrides.swarmParent.id,
      kind: 'agent',
      depth: 1,
      role: agentRole,
      topicPath: overrides.swarmParent.topicPath,
      subtopic: overrides.swarmParent.subtopic,
      model: finalModel,
      budget: {
        tokens: { cap: lvl.tokens, used: 0 },
        wallClockMs: { cap: lvl.wallMs, startedAt: Date.now() },
        fanOut: { cap: lvl.fanOut, used: 0 },
        depth: 1,
      },
      allowedToolIds: new Set(roleTools.map((t) => t.toolId ?? t.name)),
      signal: undefined as unknown as AbortSignal,
    };
    stageNode.allowedToolIds.add('spawn_child');
    try {
      roleTools.push(createSpawnChildTool(stageNode));
    } catch (err) {
      coreLogger.error({ err, role: agentRole }, 'Failed to inject spawn_child for pipeline stage — stage runs without subagent spawning');
    }
  }

  // Lazy tool discovery (docs/plans/lazy-tool-discovery.md). Decided here, after
  // roleTools is fully assembled (connector handlers + spawn_child injected
  // above), where model + size are known — agent-worker never re-derives it.
  // The per-request tool-schema payload only hurts local Ollama (each request
  // re-prefills the schemas on the iGPU; no cross-request server-side prompt
  // caching). Remote providers prefix-cache the tool block cheaply and tool-call
  // more reliably, so they stay on the proven full-schema path. Small models
  // chain multi-step discovery poorly and already get the heaviest trims, so
  // they keep the capped full-schema path above.
  let toolAdvertisement: import('@/core/agent-base').ToolAdvertisement = { mode: 'full' };
  let workerTools = roleTools;
  if (!isSmall && roleConfig.coreToolIds !== undefined) {
    try {
      const finalModelEntry = await getModelRegistry().getModelByModelId(finalModel);
      // `isSmall` above was derived from the topic model (routing.model). An
      // expert modelPreference can pin a *different* model, so re-check size
      // against the actual finalModel — a small expert-pinned Ollama model must
      // not be put on the discovery path.
      const finalIsSmall = isSmallModel(
        { modelId: finalModel, metadata: finalModelEntry?.metadata },
        orchCfg.routerSmallModelMaxParams,
      );
      if (!finalIsSmall && finalModelEntry?.provider === 'ollama' && finalModelEntry.supportsTools) {
        const { splitRoleTools } = await import('./tool-split');
        const { buildToolDiscoveryHandlers } = await import('@/tools/tool-discovery');
        const { longTail } = splitRoleTools(roleTools, roleConfig.coreToolIds);
        const discoveryHandlers = buildToolDiscoveryHandlers(longTail);
        if (discoveryHandlers.length > 0) {
          // Register ALL role tools + the discovery meta-tools (dispatch must
          // keep working); only advertisement shrinks (filtered in agent-worker).
          workerTools = [...roleTools, ...discoveryHandlers];
          toolAdvertisement = { mode: 'lazy', coreToolIds: roleConfig.coreToolIds };
          // Keep the meta-tools grantable to any children this stage spawns
          // (child tools = parent.allowedToolIds ∩ childRoleTools).
          stageNode?.allowedToolIds.add('tool_discovery');
          coreLogger.info(
            {
              role: agentRole,
              model: finalModel,
              coreCount: roleTools.length - longTail.length,
              longTailCount: longTail.length,
            },
            'Lazy tool discovery enabled for worker',
          );
        }
      }
    } catch (err) {
      coreLogger.warn({ err, model: finalModel, role: agentRole }, 'Lazy tool discovery gate skipped (non-fatal) — using full schema');
    }
  }

  const worker = await agentManager.spawn({
    sessionId: context.sessionId,
    userId: context.userId,
    workspaceId: context.workspaceId ?? null,
    topic: lane,
    model: finalModel,
    role: agentRole,
    systemPrompt,
    tools: workerTools,
    toolAdvertisement,
    parentAgentId: overrides?.swarmParent?.id,
  });

  const workerId = worker.getContext().id;

  // ── Register stage in swarm_nodes + announce on hub ──
  if (stageNode && overrides?.swarmParent) {
    stageNode.id = workerId;
    const brief = `${task}\n${input}`.slice(0, 4000);
    const briefHash = taskFingerprint({
      originalUserRequest: task,
      topicPath: stageNode.topicPath,
      parentSummary: input,
      taskBrief: task,
      constraints: [],
      inputArtifacts: [],
      expectedOutput: { shape: 'summary', maxTokens: 2000 },
      forbidden: [],
    });
    try {
      await swarmNodeRepository.create({
        id: workerId,
        rootSessionId: overrides.swarmParent.rootSessionId,
        userId: context.userId,
        workspaceId: context.workspaceId ?? null,
        parentNodeId: overrides.swarmParent.id,
        depth: 1,
        kind: 'agent',
        role: agentRole,
        expertId: null,
        topicPath: stageNode.topicPath,
        subtopic: stageNode.subtopic ?? null,
        model: finalModel,
        status: 'running',
        tokenCap: stageNode.budget.tokens.cap,
        wallClockCapMs: stageNode.budget.wallClockMs.cap,
        fanOutCap: stageNode.budget.fanOut.cap,
        briefHash,
        taskBriefPreview: brief,
        spawnMode: 'await',
      });
      getGatewayHub().publishEvent({
        type: 'swarm.node_spawned',
        source: `swarm:${overrides.swarmParent.id}`,
        userId: undefined,
        sessionId: overrides.swarmParent.rootSessionId,
        payload: {
          rootSessionId: overrides.swarmParent.rootSessionId,
          nodeId: workerId,
          parentNodeId: overrides.swarmParent.id,
          kind: 'agent',
          depth: 1,
          topicPath: stageNode.topicPath,
          subtopic: stageNode.subtopic,
          role: agentRole,
          model: finalModel,
          budget: stageNode.budget,
          taskBriefPreview: brief.slice(0, 200),
          retryAttempt: 0,
        },
      });
      // Backfill agents.parentAgentId + swarmNodeId so the agents table
      // mirrors the link (same as SwarmSpawner.backfillAgentLink).
      try {
        const { agentRepository } = await import('@/db/repositories/agent-repository');
        const { getDb } = await import('@/db/postgres');
        const { agents } = await import('@/db/schema/agents');
        const { eq } = await import('drizzle-orm');
        // Small delay so the agent row exists before we update it.
        setTimeout(async () => {
          try {
            const existing = await agentRepository.findById(workerId);
            if (!existing) return;
            await getDb()
              .update(agents)
              .set({ parentAgentId: overrides.swarmParent!.id, swarmNodeId: workerId })
              .where(eq(agents.id, workerId));
          } catch (err) {
            coreLogger.debug({ err, workerId }, 'pipeline stage backfillAgentLink skipped');
          }
        }, 25);
      } catch (err) {
        coreLogger.debug({ err }, 'pipeline stage backfillAgentLink import failed');
      }
    } catch (err) {
      coreLogger.error({ err, workerId }, 'Failed to persist swarm_node for pipeline stage');
    }
  }

  deps.emit({
    type: 'worker_spawned',
    sessionId: context.sessionId,
    userId: context.userId,
    data: { workerId, role: agentRole, model: finalModel, parentAgentId: overrides?.swarmParent?.id ?? context.id, stageName: (context as any).stageName },
    timestamp: new Date(),
  });

  try {
    const workerMessage = input
      ? `${task}\n\n--- Context from previous steps ---\n${input}`
      : task;

    const result = await worker.run(workerMessage);
    const durationMs = Date.now() - startTime;

    coreLogger.info({
      workerId, role: agentRole, model: finalModel,
      durationMs, iterations: worker.getIteration(),
      totalTokens: worker.getTotalTokens(),
      resultLength: result?.length || 0,
      parentAgentId: context.id,
    }, 'Worker completed');

    const workerResult: WorkerResult = {
      workerId,
      role: agentRole,
      result,
      model: finalModel,
      iterations: worker.getIteration(),
      durationMs,
      totalTokens: worker.getTotalTokens(),
    };

    deps.emit({
      type: 'worker_completed',
      sessionId: context.sessionId,
      userId: context.userId,
      data: workerResult,
      timestamp: new Date(),
    });

    // ── Close out the swarm node for pipeline stages ───
    if (stageNode && overrides?.swarmParent) {
      try {
        await swarmNodeRepository.updateStatus(workerId, {
          status: 'completed',
          tokensUsed: worker.getTotalTokens(),
          result: {
            nodeId: workerId,
            kind: 'agent',
            status: 'ok',
            output: result,
            usedTokens: worker.getTotalTokens(),
            durationMs,
            spawnedChildren: [],
          },
        });
        getGatewayHub().publishEvent({
          type: 'swarm.node_completed',
          source: `swarm:${overrides.swarmParent.id}`,
          userId: undefined,
          sessionId: overrides.swarmParent.rootSessionId,
          payload: {
            rootSessionId: overrides.swarmParent.rootSessionId,
            nodeId: workerId,
            parentNodeId: overrides.swarmParent.id,
            kind: 'agent',
            depth: 1,
            topicPath: stageNode.topicPath,
            role: agentRole,
            status: 'completed',
            usedTokens: worker.getTotalTokens(),
            durationMs,
          },
        });
      } catch (err) {
        coreLogger.error({ err, workerId }, 'Failed to update swarm_node on completion');
      }
    }

    getNotificationService().notify(
      context.userId,
      'agent_complete',
      `Agent "${agentRole}" completed`,
      result.slice(0, 200),
      { workerId, role: agentRole, durationMs },
    ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in worker-spawner'));

    deps.setLastWorkerResult(result);

    return result;
  } catch (error) {
    // Mark the swarm node as failed before delegating to the retry/fallback
    // path. handleWorkerFailure spawns new workers with new IDs — those
    // aren't tied to this swarm_node row, so the row's terminal state must
    // be set here from the original failure.
    if (stageNode && overrides?.swarmParent) {
      const errMsg = (error as Error).message || '';
      try {
        await swarmNodeRepository.updateStatus(workerId, {
          status: errMsg.includes('Permission denied') ? 'denied' : 'tool_error',
          tokensUsed: worker.getTotalTokens(),
          error: errMsg.slice(0, 1000),
        });
        getGatewayHub().publishEvent({
          type: 'swarm.node_completed',
          source: `swarm:${overrides.swarmParent.id}`,
          userId: undefined,
          sessionId: overrides.swarmParent.rootSessionId,
          payload: {
            rootSessionId: overrides.swarmParent.rootSessionId,
            nodeId: workerId,
            parentNodeId: overrides.swarmParent.id,
            kind: 'agent',
            depth: 1,
            topicPath: stageNode.topicPath,
            role: agentRole,
            status: 'failed',
            error: errMsg.slice(0, 200),
          },
        });
      } catch (updateErr) {
        coreLogger.error({ err: updateErr, workerId }, 'Failed to update swarm_node on error');
      }
    }
    return handleWorkerFailure(error as Error, worker, workerId, finalModel, agentRole, roleConfig, lane, task, input, context, startTime, deps, {
      systemPrompt,
      tools: workerTools,
      toolAdvertisement,
    });
  }
}

/**
 * What a failure respawn needs to recreate the ORIGINAL worker faithfully:
 * the fully assembled system prompt (expert identity, skills, workspace,
 * memories — not the bare role template) plus the exact tool surface. Without
 * this, retried/fallback workers silently ran as a different, weaker persona.
 */
interface WorkerRespawnContext {
  systemPrompt: string;
  tools: import('@/core/agent-base').ToolHandler[];
  toolAdvertisement: import('@/core/agent-base').ToolAdvertisement;
}

/**
 * Handle worker failure: transient retry (same model) → topic backup model
 * (Topics page "Backup" binding) → CLI-provider default fallback.
 */
async function handleWorkerFailure(
  error: Error,
  worker: import('@/core/agent-base').BaseAgentWorker,
  workerId: string,
  failedModel: string,
  agentRole: AgentRole,
  roleConfig: import('./types').RoleConfig,
  /** Model lane the failed worker resolved from (expert topic or role default). */
  lane: string,
  task: string,
  input: string,
  context: AgentContext,
  startTime: number,
  deps: WorkerSpawnerDeps,
  respawnCtx: WorkerRespawnContext,
): Promise<unknown> {
  coreLogger.error({ error, workerId, role: agentRole }, 'Worker agent failed');

  const failedTokens = worker.getTotalTokens();
  if (failedTokens > 0) {
    sessionRepository.incrementMessageCount(context.sessionId, failedTokens).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in worker-spawner'));
  }

  const errorMsg = error.message || '';

  // Permission denied → don't retry, don't fallback. Propagate cleanly.
  if (errorMsg.includes('Permission denied')) {
    coreLogger.info({ workerId, role: agentRole }, 'Worker stopped due to permission denial');
    deps.emit({
      type: 'worker_completed',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { workerId, role: agentRole, status: 'denied', totalTokens: failedTokens, durationMs: Date.now() - startTime },
      timestamp: new Date(),
    });
    throw error; // Propagate to caller (handleExpertMessage or orchestrator)
  }

  const wasUserStopped = errorMsg.includes('aborted') || errorMsg.includes('stopped')
    || worker.getStatus() === 'stopped';
  if (wasUserStopped) {
    coreLogger.info({ workerId, role: agentRole }, 'Worker stopped by user, not retrying');
    deps.emit({
      type: 'worker_completed',
      sessionId: context.sessionId,
      userId: context.userId,
      data: { workerId, role: agentRole, status: 'stopped', totalTokens: failedTokens, durationMs: Date.now() - startTime },
      timestamp: new Date(),
    });
    // Re-throw so the orchestrator aborts the pipeline instead of proceeding to the next stage
    throw new Error('Agent was stopped by user');
  }

  // Respawn the ORIGINAL worker (same assembled prompt + tool surface) on a
  // given model and run the task. Shared by the transient retry, the topic
  // backup, and the CLI fallback below.
  const respawnAndRun = async (model: string): Promise<string> => {
    const agentManager = getAgentManager();
    const retryWorker = await agentManager.spawn({
      sessionId: context.sessionId,
      userId: context.userId,
      workspaceId: context.workspaceId ?? null,
      topic: lane,
      model,
      role: agentRole,
      systemPrompt: respawnCtx.systemPrompt,
      tools: respawnCtx.tools,
      toolAdvertisement: respawnCtx.toolAdvertisement,
    });
    const workerMessage = input
      ? `${task}\n\n--- Context from previous steps ---\n${input}`
      : task;
    const result = await retryWorker.run(workerMessage);
    deps.emit({
      type: 'worker_completed',
      sessionId: context.sessionId,
      userId: context.userId,
      data: {
        workerId: retryWorker.getContext().id,
        role: agentRole,
        result,
        model,
        iterations: retryWorker.getIteration(),
        durationMs: Date.now() - startTime,
        totalTokens: retryWorker.getTotalTokens(),
        retryOf: workerId,
      } as WorkerResult,
      timestamp: new Date(),
    });
    return result;
  };

  // Retry transient failures (JSON parse, rate limit) with the same model
  const isTransient = errorMsg.includes('JSON') || errorMsg.includes('parse')
    || errorMsg.includes('Unterminated') || errorMsg.includes('rate_limit')
    || errorMsg.includes('overloaded');

  if (isTransient) {
    coreLogger.info({ workerId, role: agentRole, error: errorMsg }, 'Worker failed with transient error, retrying once');
    try {
      const retryResult = await respawnAndRun(failedModel);
      deps.setLastWorkerResult(retryResult);
      return retryResult;
    } catch (retryError) {
      coreLogger.error({ error: retryError, workerId, role: agentRole }, 'Retry also failed');
    }
  }

  // Topic backup model — the "Backup" binding from the Topics page. One
  // attempt on the configured fallback before the last-resort CLI/default
  // path. Skipped when unbound or when it would rerun the failed model.
  const registry = getModelRegistry();
  try {
    const backup = await registry.getBackupModelForTopic(lane);
    if (backup && backup.modelId !== failedModel) {
      coreLogger.info(
        { failedModel, backupModel: backup.modelId, topic: lane, role: agentRole },
        'Worker failed on primary model, retrying with topic backup model',
      );
      const backupResult = await respawnAndRun(backup.modelId);
      deps.setLastWorkerResult(backupResult);
      return backupResult;
    }
  } catch (backupError) {
    coreLogger.error({ error: backupError, role: agentRole }, 'Backup-model worker also failed');
  }

  // CLI sub-agent fallback
  const failedModelEntry = await registry.getModelByModelId(failedModel);
  if (failedModelEntry?.provider === 'cli') {
    const defaultModel = await registry.getDefaultModel();
    if (defaultModel && defaultModel.modelId !== failedModel && defaultModel.supportsTools) {
      coreLogger.info(
        { failedModel, fallbackModel: defaultModel.modelId, role: agentRole },
        'CLI sub-agent failed, retrying with default model',
      );
      try {
        const fallbackResult = await respawnAndRun(defaultModel.modelId);
        return fallbackResult;
      } catch (fallbackError) {
        coreLogger.error({ error: fallbackError, role: agentRole }, 'Fallback worker also failed');
      }
    }
  }

  deps.emit({
    type: 'worker_completed',
    sessionId: context.sessionId,
    userId: context.userId,
    data: {
      workerId,
      role: agentRole,
      status: 'failed',
      error: error.message,
      totalTokens: failedTokens,
      durationMs: Date.now() - startTime,
    },
    timestamp: new Date(),
  });

  getNotificationService().notify(
    context.userId,
    'agent_error',
    `Agent "${agentRole}" failed`,
    error.message,
    { workerId, role: agentRole },
  ).catch((err: unknown) => coreLogger.error({ err }, 'background task failed in worker-spawner'));

  throw new Error(`Worker "${agentRole}" failed: ${error.message}`);
}


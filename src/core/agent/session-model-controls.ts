import { configuredCliEffort } from './session-cli-settings';
import { agentRepository } from '@/db/repositories/agent-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { codexRuntimeInfo } from '@/core/cli-runtime-info';
import { getCLIToolConfig } from '@/core/cli-agent-factory';
import { resolveModel } from '@/models/resolve-model';
import { TOPICS } from '@/models/topics';
import {
  cliEfforts,
  validCliModel,
  type SessionModelControls,
  type SessionCliOverride,
} from '@/shared/session-model-controls';

/** The session has already passed owner/settings authorization at the route boundary. */
export async function readSessionModelControls(sessionId: string, userId: string): Promise<SessionModelControls> {
  const session = await sessionRepository.findById(sessionId);
  const rows = await agentRepository.findSessionRuns(sessionId, userId);
  const bindings: SessionModelControls['bindings'] = [];
  for (const topic of TOPICS.filter((t) => t.kind === 'text')) {
    const row = await resolveModel({ userId, topic: topic.value });
    if (!row || row.provider !== 'cli') continue;
    const tool = getCLIToolConfig(row.modelId);
    if (!tool) continue;
    bindings.push({
      modelName: row.name,
      topic: topic.value,
      adapter: tool.adapter ?? tool.name,
      model: row.metadata?.cliAgent?.model ?? null,
      effort: configuredCliEffort(row.metadata?.cliAgent ?? {}, tool.adapter ?? tool.name) ?? null,
      efforts: cliEfforts(tool.adapter ?? tool.name),
      modelSelectable: tool.name !== 'Mistral Vibe',
      models: [],
    });
  }
  // Explicit pipeline/expert rows need controls even when they are not a topic's current binding.
  const remembered = [
    ...rows
      .filter((run) => getCLIToolConfig(run.model))
      .flatMap((run) =>
        typeof run.metadata?.modelName === 'string' ? [{ modelName: run.metadata.modelName, topic: run.topic }] : [],
      ),
    ...(session?.context?.cliOverrides ?? []),
  ];
  const visited = new Set<string>();
  for (const run of remembered) {
    const name = run.modelName;
    const key = JSON.stringify([name, run.topic]);
    if (visited.has(key) || bindings.some((b) => b.modelName === name && b.topic === run.topic)) continue;
    visited.add(key);
    const row = await resolveModel({ userId, name });
    const tool = row?.provider === 'cli' ? getCLIToolConfig(row.modelId) : null;
    if (!row || !tool) continue;
    bindings.push({
      modelName: row.name,
      topic: run.topic,
      adapter: tool.adapter ?? tool.name,
      model: row.metadata?.cliAgent?.model ?? null,
      effort: configuredCliEffort(row.metadata?.cliAgent ?? {}, tool.adapter ?? tool.name) ?? null,
      efforts: cliEfforts(tool.adapter ?? tool.name),
      modelSelectable: tool.name !== 'Mistral Vibe',
      models: [],
    });
  }
  return {
    editable: !session?.context?.companionSupervisor && !session?.context?.companionMaintenance,
    revision: session?.context?.cliOverridesRevision ?? 0,
    overrides: session?.context?.cliOverrides ?? [],
    bindings,
    runs: rows.map((r) => {
      const info = r.metadata?.cliRun as { model?: string; effort?: string; adapter?: string } | undefined;
      return {
        id: r.id,
        role: r.role,
        topic: r.topic,
        root: r.metadata?.root === true,
        status: r.status,
        adapter: info?.adapter ?? r.model,
        model: info?.model ?? (r.model.startsWith('cli/') ? null : r.model),
        effort: info?.effort,
        at: r.createdAt.toISOString(),
      };
    }),
  };
}

/** Resolve only rows this owner can use; arbitrary arguments/permissions are never accepted. */
export async function validateSessionCliOverrides(
  entries: readonly SessionCliOverride[],
  userId: string,
): Promise<void> {
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.modelName, entry.topic, entry.role ?? null]);
    if (keys.has(key)) throw new Error('Duplicate model/topic/agent override');
    keys.add(key);
    const row = await resolveModel({ userId, name: entry.modelName });
    const tool = row?.provider === 'cli' ? getCLIToolConfig(row.modelId) : null;
    if (!row || !tool) throw new Error('CLI model is unavailable or not allowed');
    if (entry.model && tool.name === 'Mistral Vibe')
      throw new Error('Mistral Vibe model changes require its configured runtime profile');
    if (entry.model && !validCliModel(entry.model)) throw new Error('Use a valid CLI model identifier');
    if (entry.effort && !cliEfforts(tool.adapter ?? tool.name).includes(entry.effort))
      throw new Error('Effort is unsupported by this CLI');
  }
}

/** Catalog lookup is opt-in and credential-scoped; never borrow install credentials for a personal row. */
export async function readSessionCliCatalog(modelName: string, userId: string) {
  const row = await resolveModel({ userId, name: modelName });
  const tool = row?.provider === 'cli' ? getCLIToolConfig(row.modelId) : null;
  if (!row || !tool) throw new Error('CLI model unavailable');
  if (row.ownerUserId) return { models: [], error: 'Live discovery is unavailable for personal CLI credentials.' };
  if ((tool.adapter ?? tool.name) === 'Codex CLI') {
    const info = await codexRuntimeInfo(process.env);
    return { models: info.models, ...(!info.models.length ? { error: 'Codex has no cached model catalog yet.' } : {}) };
  }
  if (!tool.listModels) return { models: [], error: 'This CLI does not expose a model catalog.' };
  try {
    return { models: await tool.listModels() };
  } catch {
    const { coreLogger } = await import('@/utils/logger');
    coreLogger.warn({ modelName }, 'Session CLI catalog lookup failed');
    return { models: [], error: 'CLI model catalog unavailable; verify its login in Models.' };
  }
}

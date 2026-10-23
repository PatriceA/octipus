/**
 * What is already set up, for the onboarding guide (docs/ONBOARDING.md):
 * the guide skips or prefills a question the install already answers. Every
 * part is read on its own and fails soft to "not set up", so one broken
 * source (Ollama down, a vault read failing) never hides the guide.
 *
 * Install-wide facts (model rows, provider keys, MCP servers, the CLI tools on
 * the host) are read for admins only; anyone else gets the booleans the guide
 * needs to decide what to say, and empty lists.
 */
import { getConfig } from '@/config';
import { getSettingDefinition } from '@/config/settings-registry';
import { getSettingsService } from '@/config/settings-service';
import { findStandingNote, getHeartbeatPrefs } from '@/core/heartbeat';
import { enabledModules } from '@/core/modules/registry';
import { MODULES } from '@/modules';
import { getDb } from '@/db/postgres';
import { users } from '@/db/schema/users';
import { coreLogger } from '@/utils/logger';
import { eq, sql } from 'drizzle-orm';
import { KEY_PROVIDERS } from '@/shared/onboarding/use-cases';
import type { OnboardingProgress, OnboardingState } from '@/shared/onboarding/types';

const TEXT_LANES = ['build', 'everyday', 'verify', 'research', 'background'];
const CHANNELS = ['telegram', 'slack', 'teams', 'whatsapp'] as const;

async function soft<T>(what: string, fallback: T, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    coreLogger.debug({ err: (err as Error).message, what }, 'onboarding: state source unavailable');
    return fallback;
  }
}

export async function readProgress(userId: string): Promise<OnboardingProgress> {
  const [row] = await getDb().select({ preferences: users.preferences }).from(users).where(eq(users.id, userId)).limit(1);
  const p = (row?.preferences as { onboarding?: OnboardingProgress } | null)?.onboarding;
  return p && typeof p === 'object' ? p : {};
}

/**
 * Merge `patch` into the user's saved progress, in one UPDATE: their other
 * preferences, and a progress write landing at the same time, are kept.
 */
export async function writeProgress(userId: string, patch: OnboardingProgress): Promise<OnboardingProgress> {
  const [row] = await getDb()
    .update(users)
    .set({
      preferences: sql`coalesce(${users.preferences}, '{}'::jsonb) || jsonb_build_object('onboarding',
        coalesce(${users.preferences}->'onboarding', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ preferences: users.preferences });
  return ((row?.preferences as { onboarding?: OnboardingProgress } | null)?.onboarding) ?? {};
}

async function modelsState(isAdmin: boolean): Promise<OnboardingState['models']> {
  const { getModelRegistry } = await import('@/models/model-registry');
  const models = await getModelRegistry().getAllModelsIncludeDisabled();
  const byTopic: Record<string, string | null> = {};
  for (const m of models) {
    if (m.isEnabled === false) continue;
    for (const [topic, role] of Object.entries((m.topicRoles ?? {}) as Record<string, string>)) {
      if (role === 'primary') byTopic[topic] = m.name;
    }
  }
  const providersWithKey: string[] = [];
  if (isAdmin) {
    const { getVault } = await import('@/security/vault');
    for (const p of KEY_PROVIDERS) {
      const vaultName = getSettingDefinition(`${p.id}.apiKey`)?.vaultName;
      if (vaultName && (await getVault().getSystemSecret(vaultName).catch(() => null))) providersWithKey.push(p.id);
    }
  }
  return {
    textReady: TEXT_LANES.every((t) => byTopic[t]),
    embeddingReady: Boolean(byTopic.embedding),
    verifySeparate: Boolean(byTopic.verify && byTopic.build && byTopic.verify !== byTopic.build),
    names: isAdmin ? models.map((m) => m.name) : [],
    providersWithKey,
    byTopic: isAdmin ? byTopic : {},
  };
}

async function cliTools(): Promise<OnboardingState['cliTools']> {
  const { getProviderRouter } = await import('@/models/providers');
  const tools = await getProviderRouter().getCLIProvider().getAvailableTools();
  return tools.map((t: { name: string; available: boolean; modelPatterns: string[] }) => ({
    name: t.name,
    // The `cli/<tool>` pattern a model row names (cli-provider.ts).
    modelId: t.modelPatterns.find((p) => p.startsWith('cli/')) ?? t.modelPatterns[0],
    available: t.available,
  }));
}

async function workspaces(userId: string): Promise<OnboardingState['workspaces']> {
  const { getOrgWorkspaceManager } = await import('@/security/orgs');
  const mgr = getOrgWorkspaceManager();
  await mgr.ensureDefaultWorkspace(userId);
  const own = await mgr.listOwn(userId);
  const { listSpaces } = await import('@/core/spaces/service');
  const spaces = await listSpaces({ userId }).catch(() => []);
  return [
    ...own.map((w) => ({ id: w.id, name: w.name, slug: w.slug, kind: 'personal', isDefault: Boolean(w.isDefault) })),
    ...spaces.filter((sp) => !sp.archivedAt).map((sp) => ({ id: sp.id, name: sp.name, slug: sp.slug, kind: 'shared', isDefault: false })),
  ];
}

async function connectors(userId: string): Promise<OnboardingState['connectors']> {
  const { ALL_CONNECTORS } = await import('@/connectors');
  const { connectorVaultKeys } = await import('@/security/oauth');
  const { getVault } = await import('@/security/vault');
  return Promise.all(ALL_CONNECTORS.map(async (c) => ({
    id: c.id,
    name: c.name,
    connected: Boolean(await getVault().getByName(userId, connectorVaultKeys(c.id).accessToken).catch(() => null)),
  })));
}

async function oauthClients(): Promise<OnboardingState['oauthClients']> {
  const { OAUTH_VAULT_NAMES } = await import('@/security/oauth');
  const { getVault } = await import('@/security/vault');
  const has = async (name: string) => Boolean(await getVault().getSystemSecret(name).catch(() => null));
  return { google: await has(OAUTH_VAULT_NAMES.google.clientId), microsoft: await has(OAUTH_VAULT_NAMES.microsoft.clientId) };
}

async function channels(userId: string): Promise<OnboardingState['channels']> {
  const { getUMI } = await import('@/channels/interface');
  const { getChannelBindingManager } = await import('@/security/channel-bindings');
  const umi = getUMI();
  const linked = await getChannelBindingManager().listForUser(userId);
  return {
    configured: CHANNELS.filter((c) => umi.isChannelAvailable(c)),
    linked: [...new Set(linked.map((i) => i.channelType))],
  };
}

async function level(userId: string, toolId: string, action: string): Promise<string> {
  const { getPermissionManager } = await import('@/security/permissions');
  const check = await getPermissionManager().check(userId, toolId, action, {}, { sessionId: '', workspaceId: null });
  return check.level;
}

/** What is on, and what each use case switches on (docs/MODULES.md). */
function modulesState(): OnboardingState['modules'] {
  const byUseCase: OnboardingState['modules']['byUseCase'] = {};
  for (const m of MODULES) {
    for (const profile of m.profiles) (byUseCase[profile] ??= []).push({ id: m.id, title: m.title });
  }
  return { enabled: [...enabledModules()], byUseCase };
}

/** The guide's view of the install, for `userId`. */
export async function readOnboardingState(userId: string, isAdmin: boolean): Promise<OnboardingState> {
  const config = getConfig();
  const ollamaUrl = config.ollama?.url || 'http://localhost:11434';
  const [
    setupComplete, models, tools, ollama, spaces, mailbox, clients, connected, chats, prefs, tasksWrite, messagingSend,
    standing, roleAgents, templates, mcpServers, progress,
  ] = await Promise.all([
    soft('setup', false, async () => Boolean(await getSettingsService().get('_system.setupComplete'))),
    soft('models', { textReady: false, embeddingReady: false, verifySeparate: false, names: [], providersWithKey: [], byTopic: {} }, () => modelsState(isAdmin)),
    isAdmin ? soft('cli', [], cliTools) : Promise.resolve([]),
    isAdmin
      ? soft('ollama', false, async () => (await import('@/setup/probes')).probeOllama(ollamaUrl).then((r) => r.ok))
      : Promise.resolve(false),
    soft('workspaces', [], () => workspaces(userId)),
    soft('mailbox', null, async () => (await import('@/core/email/providers')).detectProvider(userId)),
    soft('oauth', { google: false, microsoft: false }, oauthClients),
    soft('connectors', [], () => connectors(userId)),
    soft('channels', { configured: [], linked: [] }, () => channels(userId)),
    soft('heartbeat', null, () => getHeartbeatPrefs(userId)),
    soft('permissions', 'ASK', () => level(userId, 'tasks', 'write')),
    soft('permissions', 'ASK', () => level(userId, 'messaging', 'send')),
    soft('standing', false, async () => Boolean((await findStandingNote(userId))?.body?.trim())),
    soft('roleAgents', [], async () => (await (await import('@/core/tasks/role-agents')).listRoleAgents(userId)).roles
      .map((r) => ({ role: r.role, enabled: r.enabled, pipelineTemplate: r.pipelineTemplate }))),
    soft('templates', [], async () => (await (await import('@/core/agent/templates')).listAvailableTemplates(userId)).map((t) => ({ id: t.id, name: t.name }))),
    isAdmin ? soft('mcp', [], async () => (await import('@/mcp/bridge')).getMCPBridge().getServerConfigs().map((sv) => sv.name)) : Promise.resolve([]),
    soft('progress', {}, () => readProgress(userId)),
  ]);
  return {
    isAdmin,
    setupComplete,
    models,
    cliTools: tools,
    ollama: { url: ollamaUrl, reachable: ollama },
    workspaces: spaces,
    mailbox,
    oauthClients: clients,
    connectors: connected,
    channels: chats,
    heartbeat: {
      serverEnabled: Boolean(config.heartbeat?.enabled),
      enabled: prefs?.enabled ?? false,
      watchEmail: prefs?.watchEmail ?? false,
      intervalMinutes: prefs?.intervalMinutes ?? null,
      timezone: config.heartbeat?.quietHoursTimezone ?? 'UTC',
    },
    permissions: { tasksWrite, messagingSend },
    standingInstructions: standing,
    roleAgents,
    pipelineTemplates: templates,
    mcpServers,
    workspaceRoot: isAdmin ? (config.workspace?.rootPath ?? null) : null,
    modules: modulesState(),
    progress,
  };
}

/**
 * Write the guide's standing instructions into the user's `heartbeat` note:
 * a new user-level, pinned note, or — when they already have one — the new
 * text appended under a dated heading, so nothing they wrote is lost.
 */
export async function writeStandingInstructions(userId: string, body: string): Promise<{ noteId: string; appended: boolean }> {
  const { getNoteService } = await import('@/core/knowledge/notes');
  const { HEARTBEAT_NOTE_SLUG } = await import('@/core/heartbeat');
  const existing = await findStandingNote(userId);
  const text = body.trim().slice(0, 20_000);
  const section = text.replace(/^# HEARTBEAT\s*/, '').trim();
  // Asked again (a retry, a second run with the same answers): already there.
  if (existing && section && existing.body.includes(section)) return { noteId: existing.id, appended: false };
  const scope = { kind: 'personal' as const, userId, workspaceId: existing?.workspaceId ?? null };
  const saved = await getNoteService().save({
    scope,
    ...(existing ? { id: existing.id } : { slug: HEARTBEAT_NOTE_SLUG }),
    title: 'HEARTBEAT',
    body: existing
      ? `${existing.body.trimEnd()}\n\n## Added by the setup guide (${new Date().toISOString().slice(0, 10)})\n\n${text.replace(/^# HEARTBEAT\s*/, '')}\n`
      : `${text}\n`,
  });
  const { getNoteRepository } = await import('@/db/repositories/note-repository');
  await getNoteRepository().setPinned(scope, saved.note.id, true);
  return { noteId: saved.note.id, appended: Boolean(existing) };
}

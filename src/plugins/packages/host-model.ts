/**
 * `model:complete` of the plugin host API (docs/PLUGIN-PACKAGES.md#host-api):
 * one text completion on the calling user's `everyday` model, for a package
 * call that user started. What keeps it from being a way around the rules a
 * user's own agent runs under:
 *
 * - **No CLI model, unless approved.** A lane bound to a CLI row is refused
 *   (`cli_model`): a vendor CLI is an agent harness on the host with its own
 *   tools (shell, files) run as the server user, and a plugin's prompt may
 *   carry outside data written to steer it. The one exception is a package
 *   that declares `model.trustedInput` and whose `model:cli-tools` an admin
 *   approved (`HostTokenGrant.modelCliTools`,
 *   docs/PLUGIN-PACKAGES.md#model-calls-on-cli-lanes): its call goes to the
 *   CLI with `allowCliTools`, tool-less where the CLI can be, otherwise with
 *   its normal arguments in an empty directory (`providers/cli-provider.ts`),
 *   and the audit row says `cliTools: true`.
 * - **Protection.** The call runs as part of the calling session
 *   (`sessionId`), at the highest protection level the same package call has
 *   read through the host API (`HostTokenGrant.readLevel`): level 3-4 stays on
 *   local models and level 2-3 leaves pseudonymized, as for the session's own
 *   turns (core/protection/routing.ts). The space role applies to the lane.
 * - **Cost.** A tight bucket per package and user (`MODEL_CALLS_PER_MINUTE`),
 *   a per-user daily token cap across packages (`plugins.hostModelDailyTokens`),
 *   and the user's spend budgets, all checked before the call; the cost row is
 *   tagged `requestType: plugin:<name>`.
 */
import { and, eq, gte, like, sql } from 'drizzle-orm';
import { getConfig } from '@/config';
import { checkRateLimit } from '@/core/artifacts/rate-limit';
import { getDb } from '@/db/postgres';
import { costLog } from '@/db/schema/models';
import type { Principal } from '@/security/principal';
import type { HostTokenGrant } from './host-api';

/** Completions per package and user per minute (a burst of this many, refilled over the minute). */
export const MODEL_CALLS_PER_MINUTE = 6;

export interface HostModelRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export type HostModelOutcome =
  | { ok: true; output: string; model: string; cliTools?: true }
  | { ok: false; status: number; code: string; error: string; retryAfter?: number };

/** The cost rows of plugin model calls are tagged with this request type. */
export const pluginRequestType = (plugin: string) => `plugin:${plugin}`;

/** Start of the current UTC day. */
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Tokens `userId`'s plugin model calls used today (UTC), all packages together. */
export async function pluginTokensToday(userId: string, now = new Date()): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<string>`coalesce(sum(${costLog.inputTokens} + ${costLog.outputTokens}), 0)` })
    .from(costLog)
    .where(and(eq(costLog.userId, userId), like(costLog.requestType, 'plugin:%'), gte(costLog.createdAt, utcDayStart(now))));
  return Number(row?.total ?? 0);
}

/** A rough upper estimate of what a request will use: 1 token per 3 characters in, plus the output allowed. */
export function estimateTokens(req: HostModelRequest): number {
  return Math.ceil(((req.system?.length ?? 0) + req.prompt.length) / 3) + (req.maxTokens ?? 1200);
}

/** Why a CLI lane is refused to a plugin's model call. */
export const CLI_MODEL_REFUSAL = 'The "everyday" lane runs on a CLI model, an agent with its own tools (shell, files) on the host. '
  + 'A plugin\'s model calls run there only when its manifest declares model.trustedInput and an admin approved model:cli-tools; '
  + 'otherwise bind an API or local model to the lane';

/**
 * One completion for a package call. `details` gets what the audit row of the
 * request records about the model: its name and, on a CLI lane, `cliTools: true`.
 */
export async function pluginModelComplete(
  grant: HostTokenGrant, principal: Principal, req: HostModelRequest, details: Record<string, unknown> = {},
): Promise<HostModelOutcome> {
  const limited = checkRateLimit(`plugin-host-model:${grant.plugin}:${grant.userId}`, { capacity: MODEL_CALLS_PER_MINUTE, refillPerSecond: MODEL_CALLS_PER_MINUTE / 60 });
  if (!limited.allowed) {
    return { ok: false, status: 429, code: 'rate_limited', error: `At most ${MODEL_CALLS_PER_MINUTE} model calls a minute per plugin`, retryAfter: limited.retryAfterSeconds ?? 10 };
  }

  const cap = getConfig().plugins?.hostModelDailyTokens ?? 200_000;
  if (cap <= 0) return { ok: false, status: 403, code: 'model_off', error: 'Plugin model calls are turned off on this install (plugins.hostModelDailyTokens is 0)' };
  const used = await pluginTokensToday(grant.userId);
  if (used + estimateTokens(req) > cap) {
    return { ok: false, status: 429, code: 'token_cap', error: `Today's plugin model allowance is used up (${used} of ${cap} tokens); it resets at midnight UTC` };
  }

  const inSpace = principal.workspaceKind === 'shared';
  try {
    const { checkSpend } = await import('@/security/spend-budgets');
    await checkSpend({ userId: grant.userId, workspaceId: principal.workspaceId ?? null, sessionId: grant.sessionId, funding: 'own', spaceId: null });
  } catch (err) {
    if ((err as Error).name === 'SpendBudgetExceededError') return { ok: false, status: 429, code: 'spend_budget', error: (err as Error).message };
    throw err;
  }

  const { resolveModel } = await import('@/models/resolve-model');
  const model = await resolveModel({
    userId: grant.userId, topic: 'everyday',
    ...(inSpace ? { inSpace: true, spaceRole: principal.workspaceKind === 'shared' ? principal.spaceRole : undefined } : {}),
  });
  if (!model) return { ok: false, status: 409, code: 'no_model', error: 'No model is bound to the "everyday" lane; bind one on the Topics page' };
  const cliTools = model.provider === 'cli';
  if (cliTools && grant.modelCliTools !== true) {
    return { ok: false, status: 409, code: 'cli_model', error: CLI_MODEL_REFUSAL };
  }
  details.model = model.name;
  if (cliTools) details.cliTools = true;

  const { withContentLevel } = await import('@/core/protection/session-level');
  const { getLiteLLMClient } = await import('@/models/litellm-client');
  try {
    const result = await withContentLevel(grant.readLevel ?? 1, () => getLiteLLMClient().complete({
      model: model.modelId,
      modelConfigName: model.name,
      messages: [
        ...(req.system ? [{ role: 'system' as const, content: req.system, timestamp: new Date() }] : []),
        { role: 'user' as const, content: req.prompt, timestamp: new Date() },
      ],
      temperature: req.temperature ?? 0.3,
      maxTokens: req.maxTokens ?? 1200,
      userId: grant.userId,
      ...(grant.sessionId ? { sessionId: grant.sessionId } : {}),
      workspaceId: principal.workspaceId ?? null,
      requestType: pluginRequestType(grant.plugin),
      accountingMetadata: { plugin: grant.plugin, tool: grant.tool, ...(cliTools ? { cliTools: true } : {}) },
      // Declared and approved: the CLI may run with its own tools when it has no tool-less mode.
      ...(cliTools ? { allowCliTools: true } : {}),
    }));
    return { ok: true, output: (result.content ?? '').trim(), model: model.name, ...(cliTools ? { cliTools: true as const } : {}) };
  } catch (err) {
    if ((err as Error).name === 'ProtectionRoutingError') {
      return { ok: false, status: 409, code: 'protection_level', error: (err as Error).message };
    }
    throw err;
  }
}

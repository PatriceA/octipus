/**
 * Image generation through the Image generation lane (docs/MEDIA.md): the
 * lane's primary, then its backup when the primary cannot run or fails;
 * protection levels apply (a prompt and its reference images are not
 * pseudonymized, so at a local-only level only a local model draws);
 * every call is recorded against the row that served it.
 */
import { CapabilityNotConfiguredError } from '@/core/capabilities/gates';
import type { ModelConfigEntry } from '@/db/schema/models';
import { logger } from '@/utils/logger';
import { boundTo } from './media-resolver';
import { getModelRegistry } from './model-registry';
import type { ImageAspect, ImageGenerationResult } from './providers/interface';

const log = logger.child({ component: 'image-generation' });

export interface ImageGenerationContext {
  userId?: string;
  sessionId?: string;
  agentId?: string;
  workspaceId?: string | null;
  /** The agent's role (role spend budgets). */
  role?: string;
  /** The space the call runs in (a sponsored call is checked against its budgets). */
  spaceId?: string | null;
  funding?: import('@/core/types').AgentFunding;
  signal?: AbortSignal;
}

export interface GeneratedImages extends ImageGenerationResult {
  /** The row that drew them (`model_config.name`). */
  model: string;
}

/** The lane's rows this request may use, primary first. */
async function candidates(): Promise<ModelConfigEntry[]> {
  const registry = getModelRegistry();
  const rows = [await registry.getModelForTopic('image_generation'), await registry.getBackupModelForTopic('image_generation')]
    .filter((r): r is ModelConfigEntry => !!r && boundTo(r, 'image_generation'));
  return rows.filter((r, i) => rows.findIndex((o) => o.name === r.name) === i);
}

/** Whether any row is bound (the `draw` capability). */
export async function imageGenerationAvailable(): Promise<boolean> {
  return (await candidates()).length > 0;
}

/** Does the bound primary take reference images (edits)? Shown in the tool's schema only when it does. */
export async function imageGenerationTakesReferences(): Promise<boolean> {
  const [row] = await candidates();
  if (!row) return false;
  if (row.metadata?.imageGeneration?.references !== undefined) return row.metadata.imageGeneration.references === true;
  const id = row.modelId.toLowerCase();
  return /gpt-image|gemini.*image|flash-image|nano-banana/.test(id);
}

async function refusal(row: ModelConfigEntry, ctx: ImageGenerationContext): Promise<string | null> {
  const { localOnlyLevel, runsLocally } = await import('@/core/protection/routing');
  const level = await localOnlyLevel(ctx.sessionId);
  if (level !== undefined && !(await runsLocally(row))) {
    return `this conversation is at protection level ${level}, which stays on local models, and ${row.name} is not local`;
  }
  return null;
}

/**
 * List prices per image (USD, standard quality, 1024 px) where the row names
 * none: the cost log and spend budgets see image spend even before an
 * operator enters a price. A local row costs nothing.
 */
const LIST_PRICE_PER_IMAGE: Array<[RegExp, number]> = [
  [/gpt-image-1-mini/i, 0.011],
  [/gpt-image/i, 0.042],
  [/dall-e-3/i, 0.04],
  [/dall-e-2/i, 0.02],
  [/imagen-4.*ultra/i, 0.06],
  [/imagen-4.*fast/i, 0.02],
  [/imagen/i, 0.04],
  [/gemini.*image|flash-image|nano-banana/i, 0.039],
];

/** What one image on this row costs, or undefined when unknown. */
export async function pricePerImage(row: ModelConfigEntry): Promise<number | undefined> {
  const set = row.metadata?.pricing?.perImage;
  if (typeof set === 'number') return set;
  const { runsLocally } = await import('@/core/protection/routing');
  if (await runsLocally(row)) return 0;
  return LIST_PRICE_PER_IMAGE.find(([re]) => re.test(row.modelId))?.[1];
}

async function recordUsage(row: ModelConfigEntry, ctx: ImageGenerationContext, images: number, failed: boolean, reportedCost?: number): Promise<void> {
  const { recordProviderUsage } = await import('./providers/instrumented');
  const perImage = reportedCost === undefined ? await pricePerImage(row) : undefined;
  const cost = reportedCost ?? (perImage !== undefined ? perImage * images : undefined);
  const costSource = reportedCost !== undefined ? 'provider' : row.metadata?.pricing?.perImage !== undefined ? 'row pricing' : 'list price';
  await recordProviderUsage(
    {
      model: row.modelId, modelConfigName: row.name, messages: [], requestType: 'image_generation',
      userId: ctx.userId, sessionId: ctx.sessionId, agentId: ctx.agentId, workspaceId: ctx.workspaceId ?? undefined, funding: ctx.funding,
      accountingMetadata: { images, ...(cost !== undefined ? { imageCostSource: costSource } : {}) },
    },
    row.provider,
    { model: row.modelId, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false, ...(cost !== undefined ? { reportedCost: cost } : {}) } },
    failed,
  ).catch((err: unknown) => log.warn({ err, model: row.name }, 'Image generation usage could not be recorded'));
}

export async function generateImageWithLane(
  prompt: string,
  opts: { n?: number; aspect?: ImageAspect; references?: Array<{ data: Buffer; mimeType: string }> },
  ctx: ImageGenerationContext = {},
): Promise<GeneratedImages> {
  const rows = await candidates();
  if (rows.length === 0) throw new CapabilityNotConfiguredError('draw');
  const n = Math.min(4, Math.max(1, Math.floor(opts.n ?? 1)));
  // Spend budgets apply before anything is paid for (SpendBudgetExceededError).
  if (ctx.userId && ctx.funding) {
    const { checkSpend } = await import('@/security/spend-budgets');
    await checkSpend({ userId: ctx.userId, role: ctx.role, workspaceId: ctx.workspaceId ?? null, sessionId: ctx.sessionId ?? null, funding: ctx.funding, spaceId: ctx.spaceId ?? null });
  }
  const { getProviderRouter } = await import('./providers');
  const { resolveModelKey } = await import('./model-key');
  const errors: string[] = [];
  for (const row of rows) {
    const refused = await refusal(row, ctx);
    if (refused) { errors.push(`${row.name}: ${refused}`); continue; }
    const provider = getProviderRouter().getProviderByName(row.provider);
    if (!provider?.generateImage) { errors.push(`${row.name}: provider ${row.provider} cannot generate images`); continue; }
    let apiKey: string | undefined;
    try {
      apiKey = await resolveModelKey(row, ctx.userId ?? null);
    } catch (err) {
      errors.push(`${row.name}: ${(err as Error).message}`);
      continue;
    }
    try {
      const result = await provider.generateImage({
        model: row.modelId, modelConfigName: row.name, prompt, n, aspect: opts.aspect ?? 'square',
        references: opts.references, apiKey, userId: ctx.userId, signal: ctx.signal,
      });
      await recordUsage(row, ctx, result.images.length, false, result.cost);
      if (errors.length) log.warn({ using: row.name, skipped: errors }, 'Using the Image generation backup');
      return { ...result, model: row.name };
    } catch (err) {
      await recordUsage(row, ctx, 0, true);
      errors.push(`${row.name}: ${(err as Error).message}`);
    }
  }
  throw new Error(`No image generation model could draw this: ${errors.join('; ')}`);
}

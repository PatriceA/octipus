/**
 * Who does a piece of media work (docs/MEDIA.md): the agent's own model, in
 * context (`native`); a model bound to a media lane, as a separate call
 * (`lane`); or nobody (`none`, with the reason — fail loud, never skip).
 *
 *   see   reading an image:   the agent's model if it reads images →
 *                             the Vision lane → the default model if it reads images
 *   ocr   text from a scan:   the OCR lane → the Vision lane → the default model if it reads images
 *   draw  generating images:  the Image generation lane
 *   hear  speech to text:     the Transcription lane
 *   speak text to speech:     the Speech lane
 *
 * One answer for every caller — the document pipeline, the tools, channels,
 * health and the capability gates — so they cannot disagree. Protection
 * levels apply here, so no caller can forget them: content that must stay
 * local gets a local model or `none` (with or without a session: a pipeline's
 * carried level counts too).
 */
import type { ModelConfigEntry } from '@/db/schema/models';
import { getModelRegistry } from './model-registry';

export type MediaNeed = 'see' | 'ocr' | 'draw' | 'hear' | 'speak';

/** The lane a need is served from, when it is not the agent's own model. */
export type MediaLane = 'vision' | 'ocr' | 'image_generation' | 'transcription' | 'speech' | 'default';

export type MediaResolution =
  | { mode: 'native'; row: ModelConfigEntry }
  | { mode: 'lane'; row: ModelConfigEntry; lane: MediaLane }
  | { mode: 'none'; reason: string };

export interface MediaContext {
  /** The model doing the work (an agent's row). Only `see` can be served natively. */
  agentRow?: ModelConfigEntry | null;
  /** The conversation, for its protection level. */
  sessionId?: string;
  userId?: string;
}

const NEED_LANE: Record<Exclude<MediaNeed, 'see' | 'ocr'>, MediaLane> = {
  draw: 'image_generation',
  hear: 'transcription',
  speak: 'speech',
};

const NONE_REASON: Record<MediaNeed, string> = {
  see: 'No model on this install can read images: the model doing the work cannot, no model is bound to the Vision lane, and the default model cannot either.',
  ocr: 'No model can read scanned documents: nothing is bound to the OCR or Vision lane, and the default model cannot read images.',
  draw: 'No model is bound to the Image generation lane.',
  hear: 'No model is bound to the Transcription lane.',
  speak: 'No model is bound to the Speech lane.',
};

/** A row serves a lane only when it carries it explicitly; the default model never stands in implicitly. */
export function boundTo(row: Pick<ModelConfigEntry, 'topics' | 'topicRoles'> | null | undefined, lane: string): boolean {
  return !!row && (row.topics?.includes(lane) === true || (!!row.topicRoles && lane in row.topicRoles));
}

async function lane(name: string): Promise<ModelConfigEntry | null> {
  const row = await getModelRegistry().getModelForTopic(name);
  return boundTo(row, name) ? row : null;
}

/**
 * Keep a lane's row only if the content's protection level lets it go there
 * (the session's level, or the level a pipeline carries without a session).
 * Reading an image or a scan may switch to a local model that reads images.
 * Drawing and speech never switch: a chat model is not a speech engine, so a
 * remote one at level 3–4 is refused, not replaced.
 */
async function protectedRow(row: ModelConfigEntry, need: MediaNeed, ctx: MediaContext): Promise<ModelConfigEntry | { refused: string }> {
  const routing = await import('@/core/protection/routing');
  if (need === 'see' || need === 'ocr') {
    const { modelCandidates } = await import('@/core/agent/model-selector');
    try {
      const local = await routing.localRowInstead(row, ctx.sessionId, 'vision', () => modelCandidates({ userId: ctx.userId ?? 'system' }));
      return local ?? row;
    } catch (err) {
      if (err instanceof routing.ProtectionRoutingError) return { refused: err.message };
      throw err;
    }
  }
  const level = await routing.localOnlyLevel(ctx.sessionId);
  if (level !== undefined && !(await routing.runsLocally(row))) {
    return { refused: `This content is at protection level ${level}, which stays on local models, and ${row.name} is not local. Bind a local engine to the ${NEED_LANE[need as 'draw' | 'hear' | 'speak']} lane.` };
  }
  return row;
}

async function served(row: ModelConfigEntry, laneName: MediaLane, need: MediaNeed, ctx: MediaContext): Promise<MediaResolution> {
  const kept = await protectedRow(row, need, ctx);
  if ('refused' in kept) return { mode: 'none', reason: kept.refused };
  return { mode: 'lane', row: kept, lane: laneName };
}

export async function resolveMedia(need: MediaNeed, ctx: MediaContext = {}): Promise<MediaResolution> {
  if (need === 'see' || need === 'ocr') {
    // The agent's own model reads the image in context: nothing leaves the
    // turn that was not already going to its model.
    if (need === 'see' && ctx.agentRow?.supportsVision) return { mode: 'native', row: ctx.agentRow };
    if (need === 'ocr') {
      const ocr = await lane('ocr');
      if (ocr) return served(ocr, 'ocr', need, ctx);
    }
    const vision = await lane('vision');
    if (vision) return served(vision, 'vision', need, ctx);
    // A CLI agent reads files itself, not image parts: never the fallback.
    const fallback = await getModelRegistry().getDefaultModel();
    if (fallback?.supportsVision && fallback.provider !== 'cli' && fallback.id !== ctx.agentRow?.id) return served(fallback, 'default', need, ctx);
    return { mode: 'none', reason: NONE_REASON[need] };
  }
  const laneName = NEED_LANE[need];
  const row = await lane(laneName);
  return row ? served(row, laneName, need, ctx) : { mode: 'none', reason: NONE_REASON[need] };
}

/** The row that does the work, or null — for callers that only need "who". */
export function resolvedRow(resolution: MediaResolution): ModelConfigEntry | null {
  return resolution.mode === 'none' ? null : resolution.row;
}

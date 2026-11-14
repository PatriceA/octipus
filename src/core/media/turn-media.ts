/**
 * Media a turn produced for the person (docs/MEDIA.md → Outbound): an image
 * `generate_image` drew, speech `speak` made. Tools add it while the turn
 * runs (children included: the run context carries it); the turn takes it
 * once at the end, stores it on the answer (`metadata.attachments`), and the
 * web chat and the channels deliver it with the reply.
 */
import { getRunContext } from '@/core/run-context';

export interface TurnMediaItem {
  kind: 'image' | 'audio';
  /** Absolute path in the agent's workspace. */
  path: string;
  mimeType: string;
  /** `voice`: spoken reply (sent as a voice note where the channel has them); `attach`: a file. */
  deliver: 'attach' | 'voice';
  filename?: string;
}

const MAX_PER_TURN = 12;
const MAX_RUNS = 500;
const byRun = new Map<string, TurnMediaItem[]>();

/** Add media for the person to the running turn; a call outside any turn is a no-op. */
export function addTurnMedia(item: TurnMediaItem): void {
  const runId = getRunContext()?.runId;
  if (!runId) return;
  const list = byRun.get(runId) ?? [];
  if (list.length >= MAX_PER_TURN || list.some((m) => m.path === item.path)) return;
  list.push(item);
  byRun.delete(runId);
  byRun.set(runId, list);
  if (byRun.size > MAX_RUNS) byRun.delete(byRun.keys().next().value as string);
}

/** The turn's media, once (the list is cleared). */
export function takeTurnMedia(runId: string | undefined): TurnMediaItem[] {
  if (!runId) return [];
  const list = byRun.get(runId) ?? [];
  byRun.delete(runId);
  return list;
}

/** As stored on the answer's row. */
export function turnMediaAttachments(items: TurnMediaItem[]): Array<{ type: 'image' | 'audio'; path: string; mimeType: string; filename?: string; source: 'assistant'; deliver: 'attach' | 'voice' }> {
  return items.map((m) => ({ type: m.kind, path: m.path, mimeType: m.mimeType, filename: m.filename, source: 'assistant' as const, deliver: m.deliver }));
}

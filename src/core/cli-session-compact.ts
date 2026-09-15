import { sessionRepository } from '@/db/repositories/session-repository';
import type { SessionContext } from '@/db/schema/sessions';
import { acquireCliSlot, execCli } from '@/models/providers/cli-provider';
import { canResume } from '@/shared/cli-capabilities';
import { dropCliSession } from './cli-session-store';

/**
 * Pushes octipus's own compaction down into the live vendor CLI session, so
 * the vendor isn't left holding the full pre-compaction transcript while
 * octipus believes it just summarized it — otherwise the vendor's own
 * context keeps growing until IT auto-compacts on its own terms.
 *
 * Claude Code can be compacted non-interactively (`claude -p --resume <id>
 * "/compact <instructions>"` — user-invoked slash commands expand in print
 * mode). Codex cannot: `/compact` is interactive-only, so its thread is
 * rotated instead — dropping the stored id means the next turn starts cold,
 * and that cold prompt already carries octipus's own compaction summary
 * (Task 6's delta logic only omits history on a *resumed* run). Antigravity
 * and Vibe never hold a live vendor session to compact (`canResume` is
 * false for both) — always 'skipped'.
 *
 * Runs the Claude compaction through the exact same guarded `execCli` /
 * `acquireCliSlot` path as any other CLI completion, so it counts against
 * the global concurrency gate and inherits the kill-tree timeout.
 */
export async function compactVendorSession(
  sessionId: string,
  adapterKey: string,
  instructions?: string,
): Promise<'compacted' | 'rotated' | 'skipped'> {
  if (!canResume(adapterKey)) return 'skipped';

  const session = await sessionRepository.findById(sessionId);
  const rec = (session?.context as SessionContext | undefined)?.cliSessions?.[adapterKey];
  if (!rec) return 'skipped';

  if (adapterKey !== 'Claude Code') {
    await dropCliSession(sessionId, adapterKey);
    return 'rotated';
  }

  const prompt = instructions ? `/compact ${instructions}` : '/compact';
  const release = await acquireCliSlot();
  try {
    await execCli('claude', ['-p', '--resume', rec.id, prompt]);
  } finally {
    release();
  }
  return 'compacted';
}

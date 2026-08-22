/**
 * Oversized tool output is saved, not thrown away.
 *
 * A 900KB build log or a `cat` of a large file used to be cut to the first
 * 50,000 characters with `[truncated]` on the end, and the rest was gone — not
 * only from the model's context, where it does not belong, but from the
 * transcript too, so nobody could go back for it. The model then either worked
 * from a fragment or re-ran the command to see the same fragment again.
 *
 * So the full text is written into the agent's own workspace and the model
 * gets a head, a tail, the exact size, and the path. Retrieval needs no new
 * mechanism: the agent already has filesystem and grep tools scoped to that
 * workspace, which is the whole reason the file goes there rather than into a
 * private store with a locator API in front of it.
 *
 * Best-effort by design: if the save fails the caller keeps the plain
 * truncated text, because a successful command must not be reported as an
 * error over a housekeeping write.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WorkspaceFS } from '@/security/workspace-fs';
import { coreLogger } from '@/utils/logger';

/** Directory, relative to the agent's workspace root, holding spilled output. */
export const SPILL_DIR = '.octipus/tool-output';

/** Characters kept from the start and the end of a spilled output. */
const HEAD_CHARS = 4000;
const TAIL_CHARS = 1000;

/** Filename-safe id — a tool call id reaches us from a provider. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || 'tool-output';
}

/**
 * Build the model-facing preview for text that has been saved to `relPath`.
 * Pure, so the shape is testable without touching a filesystem.
 */
export function previewFor(text: string, relPath: string): string {
  const head = text.slice(0, HEAD_CHARS);
  const tail = text.slice(-TAIL_CHARS);
  const omitted = text.length - head.length - tail.length;
  return (
    `${head}\n\n[... ${omitted} of ${text.length} characters omitted. The FULL output is saved at ` +
    `${relPath} — read or grep that file instead of re-running the command ...]\n\n${tail}`
  );
}

/**
 * Save `text` and return the preview, or return `null` when it does not need
 * saving or could not be saved (the caller then truncates as before).
 */
export async function spillToolOutput(
  text: string,
  opts: {
    toolCallId: string;
    toolName?: string;
    userId?: string;
    threshold: number;
    /** Injected in tests; production resolves the agent's own workspace. */
    fs?: WorkspaceFS;
  },
): Promise<string | null> {
  if (text.length <= opts.threshold) return null;

  // ponytail: spilled files are never swept. They live under the workspace the
  // user can see and delete, and one file per oversized call is a rounding
  // error next to what the workspace already holds. Add a reaper when a real
  // workspace grows uncomfortable, keyed on age like the other reapers.
  const relPath = `${SPILL_DIR}/${safeId(opts.toolCallId)}.txt`;
  try {
    const fs = opts.fs ?? WorkspaceFS.forAgent({ userId: opts.userId });
    // `resolve` is the sandbox boundary: it rejects traversal and refuses to
    // follow a symlink out of the workspace, so a planted link cannot redirect
    // this write.
    const abs = fs.resolve(relPath);
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    await writeFile(abs, text, { mode: 0o600 });
    // mkdir/writeFile modes are masked by the process umask; set them outright
    // so the file is owner-only whatever the umask says.
    await chmod(dirname(abs), 0o700);
    await chmod(abs, 0o600);
    return previewFor(text, relPath);
  } catch (err) {
    coreLogger.warn(
      { err, toolCallId: opts.toolCallId, tool: opts.toolName, chars: text.length },
      'Could not save oversized tool output — falling back to truncation',
    );
    return null;
  }
}

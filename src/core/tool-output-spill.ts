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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { restrictToOwnerAsync } from '@/utils/file-acl';
import { dirname } from 'node:path';
import { WorkspaceFS } from '@/security/workspace-fs';
import { contentStorageOffFor } from '@/core/agent/audience';
import type { AgentContext, MCPServer } from '@/core/types';
import type { MCPToolDefinition } from '@/mcp/protocol';
import { DEFAULT_MAX_LENGTH } from '@/utils/sanitize';
import { coreLogger } from '@/utils/logger';

/** Directory, relative to the agent's workspace root, holding spilled output. */
export const SPILL_DIR = '.octipus/tool-output';

/**
 * Characters kept from the start and the end of a spilled output.
 *
 * The head is sized to what the TRUNCATION it replaced already gave the model,
 * not to a smaller number chosen for its own sake. Saving the rest to a file is
 * the improvement; cutting the inline context from fifty thousand characters to
 * five would have been an unrelated 10x reduction applied to every oversized
 * result — a 60KB file read, a long grep, a test log — and the model would have
 * had to spend a tool call re-reading what it used to be handed. So: the same
 * head as before, plus a tail it never had, plus a path.
 *
 * The budget leaves room for the notice between them, so a spilled result is
 * never larger than the truncated one it replaces.
 */
const TAIL_CHARS = 1000;
const NOTICE_ALLOWANCE = 500;
const HEAD_CHARS = DEFAULT_MAX_LENGTH - TAIL_CHARS - NOTICE_ALLOWANCE;

/**
 * Monotonic suffix for calls that arrive with no usable id. Not every provider
 * supplies one — the Gemini streaming path builds tool calls with `id: tc.id ||
 * ''` — and a shared constant filename would make every oversized output in a
 * run overwrite the last, with the preview then pointing the model at a path
 * holding a different command's output.
 */
let anonymousSpillCounter = 0;

/** Filename-safe id — a tool call id reaches us from a provider. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return cleaned || `tool-output-${++anonymousSpillCounter}`;
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
    /** The agent whose tool produced the output: the file goes to its workspace. */
    context?: AgentContext;
    threshold: number;
    /** Injected in tests; production resolves the agent's own workspace. */
    fs?: WorkspaceFS;
  },
): Promise<string | null> {
  if (text.length <= opts.threshold) return null;
  // A session whose text stays in its own rows (a space on another install,
  // federation F-D11) writes no copy into the workspace: plain truncation.
  if (contentStorageOffFor(opts.context)) return null;

  try {
    // File tools may resolve relative paths against a dev repository/worktree.
    // Return the actual storage location so the saved output stays retrievable.
    return previewFor(text, (await saveSpill(text, opts)).path);
  } catch (err) {
    coreLogger.warn(
      { err, toolCallId: opts.toolCallId, tool: opts.toolName, chars: text.length },
      'Could not save oversized tool output — falling back to truncation',
    );
    return null;
  }
}

type SpillOpts = { toolCallId: string; context?: AgentContext; fs?: WorkspaceFS };

/** Write `text` byte-for-byte under SPILL_DIR; throws when it cannot. */
async function saveSpill(text: string, opts: SpillOpts): Promise<{ id: string; path: string }> {
  // ponytail: spilled files are never swept. They live under the workspace the
  // user can see and delete, and one file per oversized call is a rounding
  // error next to what the workspace already holds. Add a reaper when a real
  // workspace grows uncomfortable, keyed on age like the other reapers.
  const id = safeId(opts.toolCallId);
  const fs = opts.fs ?? (opts.context ? WorkspaceFS.forAgent(opts.context) : undefined);
  if (!fs) throw new Error('no agent context to save the output for');
  // `resolve` is the sandbox boundary: it rejects traversal and refuses to
  // follow a symlink out of the workspace, so a planted link cannot redirect
  // this write.
  const abs = fs.resolve(`${SPILL_DIR}/${id}.txt`);
  await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
  await writeFile(abs, text, { mode: 0o600 });
  // mkdir/writeFile modes are masked by the process umask; set them outright
  // so the file is owner-only whatever the umask says — and on Windows they
  // express nothing, so the restriction has to be applied as an ACL.
  await restrictToOwnerAsync(dirname(abs), 'directory');
  await restrictToOwnerAsync(abs);
  return { id, path: abs };
}

// ── MCP results: never cut inside the data ──────────────────────────────────
//
// The head+notice+tail preview above lands its notice in the middle of the
// text, which for an MCP result is a JSON document: the result stops parsing.
// So an oversized MCP result is replaced whole by a JSON envelope — marker
// fields first, a prefix of the data as one string field — and the exact text
// is saved for `mcp_read_result` to page through.

/** Default ceiling for one MCP result: a 60,000-char tool page plus its wrapper fits. */
export const DEFAULT_MCP_MAX_RESULT_CHARS = 65_536;
/** Tool reading a spilled MCP result back; named in the envelope's hint. */
export const READ_RESULT_TOOL = 'mcp_read_result';
/** Largest slice `mcp_read_result` returns per call. */
export const MAX_READ_CHARS = 60_000;

/** Arguments that mark a tool as paging itself. */
const PAGING_ARGS = ['offset', 'nextOffset', 'next_offset', 'cursor', 'maxChars', 'max_chars', 'page'];
/** Arguments whose value is the size of one page. */
const PAGE_SIZE_ARGS = ['maxChars', 'max_chars', 'maxLength', 'max_length', 'length', 'limit', 'pageSize', 'page_size'];
/**
 * Headroom above a page's own size: its text is JSON-escaped into the MCP
 * result (quotes and newlines double), then wrapped.
 * ponytail: 2x + 4k covers ordinary text; a page of mostly \u-escaped control
 * characters can still exceed it — measure the escaping when one shows up.
 */
const pageBudget = (page: number): number => page * 2 + 4096;

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Effective result ceiling for one MCP call: the per-tool override, else the
 * server's `maxResultChars`, else the default — but never below the page a
 * paging or read-only tool was asked for (or would return by default).
 */
export function mcpResultLimit(
  server: Pick<MCPServer, 'maxResultChars' | 'toolMaxResultChars'> | undefined,
  tool: Pick<MCPToolDefinition, 'name' | 'inputSchema' | 'annotations'> | undefined,
  args: Record<string, unknown> = {},
  toolName = tool?.name ?? '',
): number {
  const own = server?.toolMaxResultChars?.[toolName];
  const configured = positive(own) ? own : positive(server?.maxResultChars) ? server.maxResultChars : DEFAULT_MCP_MAX_RESULT_CHARS;
  const props = (tool?.inputSchema?.properties ?? {}) as Record<string, { default?: unknown; maximum?: unknown }>;
  const paging = tool?.annotations?.readOnlyHint === true || PAGING_ARGS.some((k) => k in props || k in args);
  if (!paging) return configured;
  const pages = PAGE_SIZE_ARGS.map((k) => args[k] ?? props[k]?.default ?? props[k]?.maximum).filter(positive);
  return pages.length ? Math.max(configured, pageBudget(Math.max(...pages))) : configured;
}

/**
 * Valid-JSON stand-in for an MCP result over `limit`: size, spill location and
 * the read hint first, then as much of the data's start as keeps the envelope
 * itself within `limit`. Pure, so the shape is testable without a filesystem.
 */
export function mcpEnvelope(text: string, limit: number, spill: { id: string; path: string } | { error: string }): string {
  const meta = {
    truncated: true,
    totalChars: text.length,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    ...('id' in spill
      ? {
          spillId: spill.id,
          spillPath: spill.path,
          hint: `Exact full result saved. Read it with ${READ_RESULT_TOOL}({"id":"${spill.id}","offset":0,"length":${MAX_READ_CHARS}}) and continue from nextOffset until done; or call the tool again with a smaller page.`,
        }
      : { spillError: spill.error, hint: 'Full result could not be saved; call the tool again with a smaller page.' }),
  };
  // Escaping can grow the head, so shrink by the overshoot until it fits.
  let headChars = Math.max(0, limit - JSON.stringify(meta).length - 32);
  for (;;) {
    const out = JSON.stringify({ ...meta, head: text.slice(0, headChars) });
    if (out.length <= limit || headChars === 0) return out;
    headChars = Math.max(0, headChars - (out.length - limit));
  }
}

/**
 * Envelope for an MCP result over `limit`, or `null` when it fits and goes
 * through unchanged. The save is best-effort: on failure (or for a session
 * whose content stays out of the workspace) the envelope says so instead.
 */
export async function spillMcpResult(text: string, opts: SpillOpts & { limit: number }): Promise<string | null> {
  if (text.length <= opts.limit) return null;
  if (contentStorageOffFor(opts.context)) return mcpEnvelope(text, opts.limit, { error: 'content storage is off for this session' });
  try {
    return mcpEnvelope(text, opts.limit, await saveSpill(text, opts));
  } catch (err) {
    coreLogger.warn({ err, toolCallId: opts.toolCallId, chars: text.length }, 'Could not save oversized MCP result');
    return mcpEnvelope(text, opts.limit, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One slice of a spilled result, by character offset. `id` must be a spill id
 * as the envelope gave it — no path, so the read stays inside SPILL_DIR.
 */
export async function readSpill(
  args: { id?: unknown; offset?: unknown; length?: unknown },
  opts: { context?: AgentContext; fs?: WorkspaceFS },
): Promise<{ id: string; offset: number; length: number; totalChars: number; nextOffset: number | null; done: boolean; content: string }> {
  const id = typeof args.id === 'string' ? args.id.replace(/\.txt$/, '') : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('id must be the spillId from a truncated MCP result');
  const offset = args.offset === undefined ? 0 : Number(args.offset);
  const length = args.length === undefined ? MAX_READ_CHARS : Number(args.length);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
  if (!Number.isInteger(length) || length < 1 || length > MAX_READ_CHARS) throw new Error(`length must be an integer in 1..${MAX_READ_CHARS}`);
  const fs = opts.fs ?? (opts.context ? WorkspaceFS.forAgent(opts.context) : undefined);
  if (!fs) throw new Error('no agent workspace to read from');
  let text: string;
  try {
    text = await readFile(fs.resolve(`${SPILL_DIR}/${id}.txt`), 'utf8');
  } catch {
    throw new Error(`no saved result with id '${id}'`);
  }
  const content = text.slice(offset, offset + length);
  const end = offset + content.length;
  return { id, offset, length: content.length, totalChars: text.length, nextOffset: end < text.length ? end : null, done: end >= text.length, content };
}

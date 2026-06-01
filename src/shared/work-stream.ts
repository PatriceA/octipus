/**
 * Shared, dependency-free contract for the live agent **work stream** — the
 * per-tool activity the UI renders in the side-panel / activity card.
 *
 * Used by BOTH the backend (`src/core/work-stream/renderers.ts`, emitted from
 * `src/core/tool-executor.ts`) and the web UI (`web/components/chat/*` import it
 * via the repo-relative `../../../src/shared/work-stream` path, the same trick
 * `web/lib/types/settings.ts` uses for `ChannelBinding`).
 *
 * Keep this module runtime-import-free (no node built-ins, no drizzle) so the
 * browser bundle can import it directly — that constraint is exactly why the
 * type lives here rather than next to the server renderer.
 *
 * Design note: `.octipus/end-user-ux-design.md` Thread 1. The old work stream
 * shipped only `{ toolName }` to the client, so the UI could render nothing
 * better than "Code arm used file_read". A per-tool renderer (server-side, pure)
 * turns a tool call + its result into a human one-liner plus a structured,
 * size-capped preview of the input and result, which is what these types carry.
 */

/** Structured, capped preview of a tool call's INPUT. */
export interface ToolInputPreview {
  /**
   * The primary subject of the call, so the UI can pick an icon/affordance:
   *   - `path`    a filesystem path (read/write/list/edit)
   *   - `command` a shell command line
   *   - `query`   a search query
   *   - `url`     a fetched/navigated URL
   *   - `text`    free-form text the renderer chose to surface
   *   - `json`    generic fallback — capped JSON of the args
   */
  kind: 'path' | 'command' | 'query' | 'url' | 'text' | 'json';
  /** Human-facing value, already capped + secret-redacted server-side. */
  value: string;
  /** Optional secondary detail (e.g. "recursive", "lines 1–40"). */
  detail?: string;
}

/**
 * Structured, capped preview of a tool call's RESULT. A discriminated union so
 * the UI can pick a renderer (text block, diff, exit code, list, image, file
 * ref) without re-parsing free-form strings.
 */
export type ToolResultPreview =
  /** A short text excerpt (first N chars/lines of the output). */
  | { kind: 'text'; text: string; truncated?: boolean }
  /** A unified-diff patch with line counts, for file edits. */
  | { kind: 'diff'; patch: string; added: number; removed: number }
  /** A process exit code plus the tail of its output. */
  | { kind: 'exit'; code: number; tail: string; ok: boolean }
  /** A list of short items (directory entries, search hits). */
  | { kind: 'list'; items: string[]; total?: number }
  /** A reference to an image the file view can fetch/render. */
  | { kind: 'image'; ref: string; mimeType?: string }
  /**
   * A reference to a session file the file view (Thread 2) fetches on demand —
   * the scope guard from the design: stream a preview + a ref, never the whole
   * file through the event bus.
   */
  | { kind: 'file'; path: string; version?: number; bytes?: number }
  /** Nothing meaningful to show (void result, ack). */
  | { kind: 'empty' };

/**
 * The rendered, human-facing shape of a single tool activity — what a renderer
 * produces and the UI draws. `title` is always present (renderers fall back to
 * a generic "Used <tool>"); `input`/`result` are best-effort.
 */
export interface ToolActivityRender {
  /** Human one-liner: "Read poem.md", "Edited app.ts (+12 −3)", "Ran npm test". */
  title: string;
  input?: ToolInputPreview;
  result?: ToolResultPreview;
}

/** Server-side cap for any single preview string before it hits the stream. */
export const WORK_STREAM_PREVIEW_CAP = 2000;
/** Cap for the number of list items surfaced in a `list` result preview. */
export const WORK_STREAM_LIST_CAP = 20;

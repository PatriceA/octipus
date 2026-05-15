/**
 * Persistent layout state for the TUI editor.
 *
 * Stores a JSON file at `~/.octipus/<projectHash>/tui-editor.json`
 * — one slot per project directory — covering:
 *   - Open buffer paths (file-backed only; scratch buffers don't
 *     survive restart).
 *   - Active buffer path.
 *   - Pane visibility flags.
 *   - Theme name.
 *   - Editor mode (modeless vs vim).
 *
 * The per-project scoping (`pathForProject`) keeps repos isolated.
 * Launching the editor in repo B no longer reopens files from repo
 * A, and resetting one project's layout doesn't nuke the others.
 *
 * Reads are best-effort: a missing or corrupt file returns the
 * empty default. Writes are atomic-ish (write-temp + rename) so a
 * crash mid-write doesn't leave a partial JSON the next launch
 * would refuse to parse. Debounce the write at the call-site —
 * this module is sync.
 *
 * NOT a settings system. Just a layout snapshot. Anything the user
 * configures explicitly (model, key bindings later) belongs in the
 * settings registry that the rest of the app uses.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface PersistedCursor { line: number; col: number }

export interface PersistedState {
  /** Schema version so a future shape change can ignore old files. */
  version: 1;
  openPaths: readonly string[];
  activePath: string | null;
  treeVisible: boolean;
  chatVisible: boolean;
  theme: 'dark' | 'light';
  editorMode: 'modeless' | 'vim';
  /** Cursor position per file, persisted so re-opens land where the user left off. */
  cursorByPath?: Record<string, PersistedCursor>;
}

export const DEFAULT_PERSISTED_STATE: PersistedState = {
  version: 1,
  openPaths: [],
  activePath: null,
  treeVisible: true,
  chatVisible: true,
  theme: 'dark',
  editorMode: 'modeless',
  cursorByPath: {},
};

function legacyDefaultPath(): string {
  return join(homedir(), '.octipus', 'tui-editor.json');
}

/**
 * Per-project persistence path. Hashes the absolute project path
 * to a short, filesystem-safe slug so two projects with similar
 * names don't collide. The hash is sha1 truncated — collision risk
 * for a handful of repos on one machine is irrelevant.
 *
 * Falls back to the legacy single-file location when projectPath
 * is omitted, so older code paths and tests keep working without
 * modification.
 */
export function pathForProject(projectPath?: string): string {
  if (!projectPath) return legacyDefaultPath();
  const slug = createHash('sha1').update(resolve(projectPath)).digest('hex').slice(0, 12);
  return join(homedir(), '.octipus', 'projects', slug, 'tui-editor.json');
}

/**
 * Read the persisted state. Returns `DEFAULT_PERSISTED_STATE` on
 * any failure (missing file, parse error, version mismatch).
 *
 * `path` defaults to the legacy single-file location for backwards
 * compatibility — callers that want per-project isolation pass the
 * result of `pathForProject(projectPath)`. Tests can pass any temp
 * path.
 */
export function loadPersistedState(path: string = legacyDefaultPath()): PersistedState {
  try {
    if (!existsSync(path)) return DEFAULT_PERSISTED_STATE;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (parsed.version !== 1) return DEFAULT_PERSISTED_STATE;
    return {
      version: 1,
      openPaths: Array.isArray(parsed.openPaths) ? parsed.openPaths.filter((p): p is string => typeof p === 'string') : [],
      activePath: typeof parsed.activePath === 'string' ? parsed.activePath : null,
      treeVisible: typeof parsed.treeVisible === 'boolean' ? parsed.treeVisible : true,
      chatVisible: typeof parsed.chatVisible === 'boolean' ? parsed.chatVisible : true,
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      editorMode: parsed.editorMode === 'vim' ? 'vim' : 'modeless',
      cursorByPath: sanitizeCursors(parsed.cursorByPath),
    };
  } catch {
    return DEFAULT_PERSISTED_STATE;
  }
}

/**
 * Atomic-ish save: write to `<path>.tmp` then rename. A crash
 * mid-write at worst leaves the previous state intact.
 */
function sanitizeCursors(value: unknown): Record<string, PersistedCursor> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, PersistedCursor> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { line?: unknown; col?: unknown };
    if (typeof r.line === 'number' && typeof r.col === 'number') {
      out[key] = { line: Math.max(0, Math.floor(r.line)), col: Math.max(0, Math.floor(r.col)) };
    }
  }
  return out;
}

export function savePersistedState(state: PersistedState, path: string = legacyDefaultPath()): boolean {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

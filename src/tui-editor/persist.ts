/**
 * Persistent layout state for the TUI editor.
 *
 * Stores a JSON file at `~/.octipus/tui-editor.json` covering:
 *   - Open buffer paths (file-backed only; scratch buffers don't
 *     survive restart).
 *   - Active buffer path.
 *   - Pane visibility flags.
 *   - Theme name.
 *   - Editor mode (modeless vs vim).
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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface PersistedState {
  /** Schema version so a future shape change can ignore old files. */
  version: 1;
  openPaths: readonly string[];
  activePath: string | null;
  treeVisible: boolean;
  chatVisible: boolean;
  theme: 'dark' | 'light';
  editorMode: 'modeless' | 'vim';
}

export const DEFAULT_PERSISTED_STATE: PersistedState = {
  version: 1,
  openPaths: [],
  activePath: null,
  treeVisible: true,
  chatVisible: true,
  theme: 'dark',
  editorMode: 'modeless',
};

function defaultPath(): string {
  return join(homedir(), '.octipus', 'tui-editor.json');
}

/**
 * Read the persisted state. Returns `DEFAULT_PERSISTED_STATE` on
 * any failure (missing file, parse error, version mismatch).
 *
 * `path` defaults to `~/.octipus/tui-editor.json`; tests can pass
 * a temp path.
 */
export function loadPersistedState(path: string = defaultPath()): PersistedState {
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
    };
  } catch {
    return DEFAULT_PERSISTED_STATE;
  }
}

/**
 * Atomic-ish save: write to `<path>.tmp` then rename. A crash
 * mid-write at worst leaves the previous state intact.
 */
export function savePersistedState(state: PersistedState, path: string = defaultPath()): boolean {
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

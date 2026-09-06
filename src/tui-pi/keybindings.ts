/**
 * Octipus app-level keybindings.
 *
 * Augments pi-tui's `Keybindings` interface via declaration merging
 * so `KeybindingsManager.matches(data, 'app.palette.open')` is
 * type-safe alongside the built-in `tui.editor.*` / `tui.input.*` /
 * `tui.select.*` bindings.
 *
 * User overrides live at `~/.octipus/keybindings.json`:
 *
 *   {
 *     "app.palette.open": "ctrl+p",
 *     "app.tree.toggle": "ctrl+b"
 *   }
 *
 * Missing keys keep the defaults below. Reading happens once on
 * launch; `/reload` (Phase 6) calls `loadOctipusKeybindings` again
 * and `setUserBindings` on the active manager.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type KeybindingDefinitions,
  type KeybindingsConfig,
  KeybindingsManager,
  TUI_KEYBINDINGS,
  setKeybindings as setGlobalKeybindings,
} from '@mariozechner/pi-tui';

declare module '@mariozechner/pi-tui' {
  interface Keybindings {
    // Editor surface
    'app.tree.toggle': true;
    'app.chat.toggle': true;
    'app.pane.cycle': true;
    'app.buffer.next': true;
    'app.buffer.prev': true;
    'app.buffer.close': true;
    'app.file.open': true;
    'app.file.save': true;
    'app.find.open': true;
    'app.replace.open': true;
    // Workspace + tooling
    'app.workspace.switch': true;
    'app.mcp.list': true;
    // Chat surface (also valid in editor)
    'app.palette.open': true;
    'app.help.open': true;
    'app.quit': true;
    'app.voice.talk': true;
    'app.subagents.toggle': true;
  }
}

// NOTE: Avoid ctrl+m / ctrl+h / ctrl+j / ctrl+i / ctrl+[ as defaults — those
// bytes are indistinguishable from Enter / Backspace / LF / Tab / Esc on
// terminals that don't enable the Kitty keyboard protocol, so binding them
// would hijack normal text input. Use Alt-prefixed keys or F-keys instead.
export const OCTIPUS_APP_KEYBINDINGS = {
  'app.tree.toggle':     { defaultKeys: 'ctrl+b',           description: 'Toggle file tree' },
  'app.chat.toggle':     { defaultKeys: 'alt+j',            description: 'Toggle chat pane' },
  'app.pane.cycle':      { defaultKeys: ['ctrl+\\', 'f6'],  description: 'Cycle focused pane' },
  'app.buffer.next':     { defaultKeys: ['alt+.', 'f3'],    description: 'Next buffer' },
  'app.buffer.prev':     { defaultKeys: ['alt+,', 'f2'],    description: 'Previous buffer' },
  'app.buffer.close':    { defaultKeys: 'ctrl+w',           description: 'Close active buffer' },
  'app.file.open':       { defaultKeys: 'ctrl+o',           description: 'Open file picker' },
  'app.file.save':       { defaultKeys: 'ctrl+s',           description: 'Save active buffer' },
  'app.find.open':       { defaultKeys: 'ctrl+f',           description: 'Find in buffer' },
  'app.replace.open':    { defaultKeys: 'alt+r',            description: 'Find & replace' },
  'app.workspace.switch':{ defaultKeys: 'ctrl+k',           description: 'Switch workspace' },
  'app.mcp.list':        { defaultKeys: 'ctrl+e',           description: 'MCP server list' },
  'app.palette.open':    { defaultKeys: ['ctrl+p', 'f4'],   description: 'Command palette' },
  'app.help.open':       { defaultKeys: 'f5',               description: 'Show hotkeys' },
  'app.quit':            { defaultKeys: 'ctrl+q',           description: 'Quit' },
  'app.voice.talk':      { defaultKeys: ['alt+t', 'f8'],    description: 'Push-to-talk: start/stop voice input' },
  'app.subagents.toggle':{ defaultKeys: ['alt+s', 'f7'],    description: 'Expand/collapse the subagent panel' },
} as const satisfies KeybindingDefinitions;

const DEFAULT_USER_PATH = join(homedir(), '.octipus', 'keybindings.json');

/**
 * Read user keybinding overrides from `~/.octipus/keybindings.json`.
 * Returns an empty config on missing / invalid files — defaults apply.
 */
export function loadOctipusKeybindings(path: string = DEFAULT_USER_PATH): KeybindingsConfig {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as KeybindingsConfig;
  } catch {
    return {};
  }
}

/**
 * Build a merged manager (pi-tui defaults + octipus defaults + user
 * overrides) and install it as the active keybindings registry.
 * Components that call `getKeybindings()` directly will pick it up.
 */
export function installOctipusKeybindings(userBindings?: KeybindingsConfig): KeybindingsManager {
  const merged = { ...TUI_KEYBINDINGS, ...OCTIPUS_APP_KEYBINDINGS };
  const manager = new KeybindingsManager(merged, userBindings ?? loadOctipusKeybindings());
  setGlobalKeybindings(manager);
  return manager;
}

/**
 * Convenience: list every binding (pi-tui + octipus + user
 * overrides) for `/hotkeys` rendering. Sorted by keybinding id.
 */
export function listAllKeybindings(manager: KeybindingsManager): Array<{ id: string; keys: string[]; description: string }> {
  // KeybindingsManager doesn't expose its definitions, so we iterate
  // the merged static map instead — same source of truth.
  const merged = { ...TUI_KEYBINDINGS, ...OCTIPUS_APP_KEYBINDINGS } as KeybindingDefinitions;
  return Object.entries(merged)
    .map(([id, def]) => ({
      id,
      keys: manager.getKeys(id as never).map(String),
      description: def.description ?? '',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

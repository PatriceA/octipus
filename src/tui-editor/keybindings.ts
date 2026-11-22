/**
 * Keybindings only the file editor has, on top of the shared app set in
 * `tui-pi/keybindings.ts`. Same mechanism and the same user file
 * (`~/.octipus/keybindings.json`) for overrides.
 */
import {
  getKeybindings,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from '@/tui-kit';
import { listAllKeybindings, OCTIPUS_APP_KEYBINDINGS } from '@/tui-pi/keybindings';

declare module '@/tui-kit' {
  interface Keybindings {
    'app.file.saveAs': true;
    'app.vim.toggle': true;
    'app.view.wrap': true;
    'app.goto.line': true;
    'app.search.project': true;
  }
}

export const EDITOR_KEYBINDINGS = {
  'app.file.saveAs':  { defaultKeys: 'f12',   description: 'Save the active buffer under a new path (Save As)' },
  'app.vim.toggle':   { defaultKeys: 'alt+m', description: 'Switch vim mode on or off' },
  'app.view.wrap':    { defaultKeys: 'alt+z', description: 'Soft wrap long lines on or off' },
  'app.goto.line':    { defaultKeys: 'ctrl+g', description: 'Go to a line (line or line:column)' },
  'app.search.project': { defaultKeys: ['ctrl+shift+f', 'alt+g'], description: 'Search the project\'s files' },
} as const satisfies KeybindingDefinitions;

/**
 * Install the shared bindings plus the editor's, keeping the user's
 * overrides: those already loaded unless `userBindings` is given.
 */
export function installEditorKeybindings(userBindings: KeybindingsConfig = getKeybindings().getUserBindings()): KeybindingsManager {
  const manager = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...OCTIPUS_APP_KEYBINDINGS, ...EDITOR_KEYBINDINGS }, userBindings);
  setKeybindings(manager);
  return manager;
}

/** Every binding the editor answers to, for the hotkeys overlay. Sorted by id. */
export function listEditorKeybindings(manager: KeybindingsManager): Array<{ id: string; keys: string[]; description: string }> {
  const editor = Object.entries(EDITOR_KEYBINDINGS).map(([id, def]) => ({
    id,
    keys: manager.getKeys(id as keyof typeof EDITOR_KEYBINDINGS).map(String),
    description: def.description,
  }));
  return [...listAllKeybindings(manager), ...editor].sort((a, b) => a.id.localeCompare(b.id));
}

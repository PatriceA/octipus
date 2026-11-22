/**
 * The terminal toolkit seam: the only module that imports pi-tui.
 *
 * Everything the chat and the editor take from pi-tui is re-exported here, by
 * name, so an upgrade to the maintained package, a fork or a replacement of
 * the screen layer touches this directory and nothing else
 * (docs/plans/tui-modernization.md §4.3). `seam.test.ts` fails when a file
 * elsewhere imports pi-tui directly.
 *
 * Add a name here when a caller needs it; do not re-export the whole package.
 */
export {
  CombinedAutocompleteProvider,
  Container,
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  Input,
  isFocusable,
  KeybindingsManager,
  Markdown,
  matchesKey,
  ProcessTerminal,
  SelectList,
  setKeybindings,
  Spacer,
  Text,
  TUI,
  TUI_KEYBINDINGS,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@mariozechner/pi-tui';
export type {
  Component,
  EditorOptions,
  EditorTheme,
  Focusable,
  KeybindingDefinitions,
  Keybindings,
  KeybindingsConfig,
  MarkdownTheme,
  OverlayHandle,
  OverlayOptions,
  SelectItem,
  SelectListTheme,
  SlashCommand,
  Terminal,
} from '@mariozechner/pi-tui';
// Not on pi-tui 0.73's public entry (no exports map, so the dist path
// resolves). If an upgrade breaks it, copy the ~40-line ANSI-aware slicer here.
export { sliceByColumn } from '@mariozechner/pi-tui/dist/utils.js';
export { displayLine, displayText, frameRow } from './terminal-text';

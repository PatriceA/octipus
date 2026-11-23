/**
 * The terminal toolkit seam: the only module that imports pi-tui.
 *
 * Everything the chat and the editor take from pi-tui is re-exported here, by
 * name, so an upgrade, a fork or a replacement of the screen layer touches
 * this directory and nothing else (docs/plans/tui-modernization.md §4.3).
 * `seam.test.ts` fails when a file elsewhere imports pi-tui directly.
 *
 * pi-tui is `@earendil-works/pi-tui`, pinned to an exact version: breaking
 * changes land in its minor releases, so an upgrade is its own change with
 * the PTY suites as the gate.
 *
 * Add a name here when a caller needs it; do not re-export the whole package.
 */
export {
  CombinedAutocompleteProvider,
  Container,
  CURSOR_MARKER,
  Editor,
  fuzzyFilter,
  getKeybindings,
  Input,
  isFocusable,
  isViewportTUI,
  KeybindingsManager,
  Markdown,
  matchesKey,
  MouseRegion,
  ProcessTerminal,
  ScrollView,
  SelectList,
  setKeybindings,
  sliceByColumn,
  Spacer,
  stripTerminalSequences,
  Text,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  TuiMainScreen,
  truncateToWidth,
  VStack,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui';
export type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
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
  ScrollViewOptions,
  SelectItem,
  SelectListTheme,
  SlashCommand,
  StackChild,
  Terminal,
  TUI,
  TuiAltScreenOptions,
  TuiMouseEvent,
  TuiMouseEventResult,
  TuiStopOptions,
  ViewportTUI,
} from '@earendil-works/pi-tui';
export { copyToClipboard, type ClipboardEnvironment, type ClipboardMethod, type ClipboardResult } from './clipboard';
export { displayLine, displayText, frameRow } from './terminal-text';

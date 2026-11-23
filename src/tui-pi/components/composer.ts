/**
 * Composer: pi-tui's Editor preconfigured for the Octipus shell.
 *
 * Phase 2 wiring:
 *   - Slash command autocomplete (typing `/`) backed by
 *     OCTIPUS_SLASH_COMMANDS via pi-tui's CombinedAutocompleteProvider.
 *   - File path autocomplete (`./`, `../`, `~/`, `@`, Tab) supplied
 *     by the same provider (uses `fd` if installed, otherwise
 *     readdirSync prefix matching — both work without extra wiring).
 *   - Paste markers `[paste #N +M lines]` come for free from the
 *     Editor; callers should consume `getExpandedText()` on submit.
 *
 *   - `@` mentions of agents, skills and sessions (`mentions`), listed
 *     above the matching files (`../mentions.ts`).
 */
import { CombinedAutocompleteProvider, Editor, type EditorOptions, type TUI } from '@/tui-kit';
import { existsSync } from 'node:fs';
import { OCTIPUS_SLASH_COMMANDS } from '../slash-commands';
import { type Mention, MentionAutocompleteProvider } from '../mentions';
import { getEditorTheme } from '../theme/defaults';

export interface ComposerOptions extends EditorOptions {
  /** Working directory used for file completion (default: process.cwd()). */
  basePath?: string;
  /** Override `fd` discovery (mainly for tests). */
  fdPath?: string | null;
  /** What `@` mentions can name; without it `@` completes files only. */
  mentions?: () => Promise<Mention[]>;
}

const FD_CANDIDATES = ['/usr/bin/fd', '/usr/local/bin/fd', '/opt/homebrew/bin/fd', '/usr/bin/fdfind'];

function detectFdPath(): string | null {
  for (const candidate of FD_CANDIDATES) {
    try { if (existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return null;
}

export class Composer extends Editor {
  constructor(tui: TUI, options: ComposerOptions = {}) {
    const { basePath = process.cwd(), fdPath = detectFdPath(), mentions, ...editorOptions } = options;
    super(tui, getEditorTheme(), { paddingX: 1, autocompleteMaxVisible: 5, ...editorOptions });
    const files = new CombinedAutocompleteProvider(OCTIPUS_SLASH_COMMANDS, basePath, fdPath);
    this.setAutocompleteProvider(mentions ? new MentionAutocompleteProvider(files, mentions) : files);
  }
}

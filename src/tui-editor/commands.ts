/**
 * Registered commands for the command palette.
 *
 * The palette (Ctrl+P) fuzzy-matches `title` and `keywords` and
 * dispatches `run()` on selection. Add a command here to surface it
 * in the palette; it should be self-contained — store mutations,
 * overlay opens, etc. — so the palette stays a generic dispatcher.
 */

import type { AgentStore } from './stores/agent-store';
import type { BufferStore } from './stores/buffer-store';
import type { LayoutStore } from './stores/layout-store';
import type { WorkspaceStore } from './stores/workspace-store';
import { getTheme, listThemes, setTheme } from './theme';

export interface CommandContext {
  layout: LayoutStore;
  buffers: BufferStore;
  agent: AgentStore;
  workspace: WorkspaceStore;
}

export interface Command {
  id: string;
  title: string;
  /** Shortcut hint shown in the palette ("Ctrl+S"); not bound here. */
  shortcut?: string;
  keywords?: string[];
  run(ctx: CommandContext): void | Promise<void>;
}

export const commands: Command[] = [
  // ── Layout ──────────────────────────────────────────────────────
  { id: 'toggle-tree', title: 'Toggle file tree', shortcut: 'Ctrl+B',
    keywords: ['sidebar', 'files'],
    run: ({ layout }) => layout.toggleTree() },
  { id: 'toggle-chat', title: 'Toggle chat pane', shortcut: 'Ctrl+J',
    run: ({ layout }) => layout.toggleChat() },
  { id: 'focus-next-pane', title: 'Focus next pane', shortcut: 'Ctrl+\\',
    run: ({ layout }) => layout.cycleFocus(1) },

  // ── Buffers ─────────────────────────────────────────────────────
  { id: 'open-file', title: 'Open file…', shortcut: 'Ctrl+O',
    keywords: ['edit', 'load'],
    run: ({ layout }) => layout.openOverlay({ kind: 'file-picker' }) },
  { id: 'next-buffer', title: 'Next buffer', shortcut: 'Ctrl+Tab',
    run: ({ buffers }) => buffers.cycle(1) },
  { id: 'prev-buffer', title: 'Previous buffer', shortcut: 'Ctrl+Shift+Tab',
    run: ({ buffers }) => buffers.cycle(-1) },
  { id: 'close-buffer', title: 'Close current buffer', shortcut: 'Ctrl+W',
    run: ({ buffers }) => {
      const a = buffers.active();
      if (a) buffers.close(a.id);
    } },
  { id: 'new-scratch', title: 'New scratch buffer',
    run: ({ buffers }) => { buffers.openScratch(); } },

  // ── Find / goto ─────────────────────────────────────────────────
  { id: 'goto-line', title: 'Go to line…', shortcut: 'Ctrl+G',
    run: ({ layout }) => layout.openOverlay({ kind: 'goto-line' }) },
  { id: 'find', title: 'Find in buffer…', shortcut: 'Ctrl+F',
    run: ({ layout }) => layout.openOverlay({ kind: 'find' }) },
  { id: 'replace', title: 'Find & replace…', shortcut: 'Ctrl+H',
    run: ({ layout }) => layout.openOverlay({ kind: 'replace' }) },

  // ── Workspace ───────────────────────────────────────────────────
  { id: 'switch-workspace', title: 'Switch workspace…',
    keywords: ['multi-user', 'org'],
    run: ({ layout }) => layout.openOverlay({ kind: 'workspace-picker' }) },

  // ── Chat ────────────────────────────────────────────────────────
  { id: 'clear-chat', title: 'Clear chat', shortcut: 'Ctrl+K',
    run: ({ agent }) => agent.clearMessages() },

  // ── Theme ───────────────────────────────────────────────────────
  ...listThemes().map((name): Command => ({
    id: `theme-${name}`,
    title: `Theme: ${name}${getTheme().name === name ? ' (current)' : ''}`,
    keywords: ['color', 'palette'],
    run: () => setTheme(name),
  })),

  // ── Help ────────────────────────────────────────────────────────
  { id: 'show-shortcuts', title: 'Show all keyboard shortcuts',
    keywords: ['help', 'keys'],
    run: ({ layout }) => layout.openOverlay({ kind: 'help' }) },
];

/**
 * Fuzzy-match query against a list of commands. Returns commands
 * sorted by score (best first). Score is a lightweight heuristic:
 * +5 for exact-match prefix, +3 per matched word, +1 per char
 * subsequence hit. Empty query returns the original order.
 */
export function fuzzyMatch(query: string, list: readonly Command[] = commands): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const scored: Array<{ c: Command; s: number }> = [];
  for (const c of list) {
    const hay = (c.title + ' ' + (c.keywords ?? []).join(' ')).toLowerCase();
    let score = 0;
    if (hay.startsWith(q)) score += 5;
    for (const word of q.split(/\s+/)) {
      if (!word) continue;
      if (hay.includes(word)) score += 3;
    }
    // Subsequence pass.
    let i = 0;
    for (const ch of hay) {
      if (ch === q[i]) {
        score += 1;
        i++;
        if (i >= q.length) break;
      }
    }
    if (score > 0) scored.push({ c, s: score });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.c);
}

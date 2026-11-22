/**
 * What the parts of the editor shell share: the stores, the overlays, and
 * the ways to tell the user something. `OctipusEditorApp` builds one and
 * hands it to the file operations, the agent-edit review, the commands and
 * the persistence, so none of them needs the app itself.
 */
import type { TUI } from '@/tui-kit';
import type { BufferStore } from '../stores/buffer-store';
import type { LayoutStore } from '../stores/layout-store';
import type { OverlaySlots } from './overlay-slots';
import type { PendingPrompts } from './pending-prompts';

export interface EditorContext {
  readonly tui: TUI;
  readonly buffers: BufferStore;
  readonly layout: LayoutStore;
  readonly overlays: OverlaySlots;
  /** Background questions waiting for the resolve key (never opened on their own). */
  readonly pending: PendingPrompts;
  readonly projectPath: string;
  /** A line in the mode bar: an error until replaced, `info` until the next key. */
  notice(text: string, tone?: 'error' | 'info'): void;
  /** A message in the chat transcript; `Error: …` is shown as an error. */
  pushMessage(role: 'user' | 'assistant' | 'system', content: string): void;
  /** A plain system line in the chat transcript. */
  log(content: string): void;
  /** Give the keyboard back to the focused pane. */
  refocus(): void;
  /** Whether the app is shutting down (late async results are dropped). */
  exiting(): boolean;
}

/**
 * Lightweight dispatcher for the overlays the chat shell knows
 * about. Centralizes overlay options (anchor, sizing) so callers
 * don't pass `OverlayOptions` literals at every call site.
 *
 * Every overlay goes through `FramedOverlay`: pi-tui composites overlays
 * after the app's frame, so the frame's backstop never sees their rows.
 *
 * Only handles capturing overlays for now. Phase 7 will add the
 * non-capturing widget channel (status badges, voice meter, MCP
 * indicator).
 */
import { type Component, type Focusable, isFocusable, type OverlayHandle, type OverlayOptions, type TUI, truncateToWidth } from '@mariozechner/pi-tui';
import { frameRow } from '../terminal-text';
import { ApprovalPrompt, type ApprovalPromptOptions } from '../components/approval-prompt';
import { CommandPalette, type CommandPaletteOptions } from '../components/command-palette';
import { LoginPrompt, type LoginPromptOptions } from '../components/login-prompt';
import { PermissionPrompt, type PermissionPromptOptions } from '../components/permission-prompt';

export interface OverlayController {
  showPermissionPrompt(options: PermissionPromptOptions): OverlayHandle;
  showApprovalPrompt(options: ApprovalPromptOptions): OverlayHandle;
  showCommandPalette(options: CommandPaletteOptions): OverlayHandle;
  /** Returns the component too — the caller needs it to report a server-side error back into the box. */
  showLoginPrompt(options: LoginPromptOptions): { handle: OverlayHandle; prompt: LoginPrompt };
  /**
   * Generic centered modal — used by editor-specific overlays
   * (file picker, find/replace, diff) that the chat shell doesn't
   * need to know about.
   */
  showModal(component: Component, options?: OverlayOptions): OverlayHandle;
}

const PERMISSION_OVERLAY: OverlayOptions = {
  anchor: 'bottom-center',
  width: '60%',
  minWidth: 40,
  margin: { bottom: 2, left: 2, right: 2 },
};

const COMMAND_PALETTE_OVERLAY: OverlayOptions = {
  anchor: 'center',
  width: '85%',
  minWidth: 60,
  maxHeight: '85%',
  margin: 1,
};

/**
 * One rendered overlay row is one terminal row no wider than the overlay:
 * whatever the wrapped component draws, no newline, carriage return or
 * control byte reaches the terminal. Input and focus pass straight through.
 * Each prompt still cleans its own text (`displayLine`) so it lays out
 * correctly; this is the backstop for the ones that do not.
 */
export class FramedOverlay implements Component, Focusable {
  constructor(readonly inner: Component) {}
  render(width: number): string[] {
    return this.inner.render(width).map(line => truncateToWidth(frameRow(line), width, ''));
  }
  handleInput(data: string): void { this.inner.handleInput?.(data); }
  invalidate(): void { this.inner.invalidate(); }
  get wantsKeyRelease(): boolean | undefined { return this.inner.wantsKeyRelease; }
  get focused(): boolean { return isFocusable(this.inner) && this.inner.focused; }
  set focused(value: boolean) { if (isFocusable(this.inner)) this.inner.focused = value; }
}

export function createOverlayController(tui: TUI): OverlayController {
  const show = (component: Component, options: OverlayOptions): OverlayHandle => {
    const handle = tui.showOverlay(new FramedOverlay(component), options);
    handle.focus();
    return handle;
  };
  return {
    showApprovalPrompt: options => show(new ApprovalPrompt(options), PERMISSION_OVERLAY),
    showPermissionPrompt: options => show(new PermissionPrompt(options), PERMISSION_OVERLAY),
    showLoginPrompt(options) {
      const prompt = new LoginPrompt(options);
      return { handle: show(prompt, PERMISSION_OVERLAY), prompt };
    },
    showCommandPalette: options => show(new CommandPalette(options), COMMAND_PALETTE_OVERLAY),
    showModal: (component, options) => show(component, options ?? COMMAND_PALETTE_OVERLAY),
  };
}

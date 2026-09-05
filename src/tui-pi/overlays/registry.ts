/**
 * Lightweight dispatcher for the overlays the chat shell knows
 * about. Centralizes overlay options (anchor, sizing) so callers
 * don't pass `OverlayOptions` literals at every call site.
 *
 * Only handles capturing overlays for now. Phase 7 will add the
 * non-capturing widget channel (status badges, voice meter, MCP
 * indicator).
 */
import type { Component, OverlayHandle, OverlayOptions, TUI } from '@mariozechner/pi-tui';
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

export function createOverlayController(tui: TUI): OverlayController {
  return {
    showApprovalPrompt(options) {
      const component = new ApprovalPrompt(options);
      const handle = tui.showOverlay(component, PERMISSION_OVERLAY);
      handle.focus();
      return handle;
    },
    showPermissionPrompt(options) {
      const component = new PermissionPrompt(options);
      const handle = tui.showOverlay(component, PERMISSION_OVERLAY);
      handle.focus();
      return handle;
    },
    showLoginPrompt(options) {
      const prompt = new LoginPrompt(options);
      const handle = tui.showOverlay(prompt, PERMISSION_OVERLAY);
      handle.focus();
      return { handle, prompt };
    },
    showCommandPalette(options) {
      const component = new CommandPalette(options);
      const handle = tui.showOverlay(component, COMMAND_PALETTE_OVERLAY);
      handle.focus();
      return handle;
    },
    showModal(component, options) {
      const handle = tui.showOverlay(component, options ?? COMMAND_PALETTE_OVERLAY);
      handle.focus();
      return handle;
    },
  };
}

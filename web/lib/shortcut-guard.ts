/**
 * When a one-key page shortcut (Q for a quick to-do, N, / and T on the
 * notes and to-dos pages) may act on a key press. One rule for every page,
 * so a key typed into a field or an open dialog, menu or overlay is never
 * taken as a shortcut.
 */

/** True while the user is typing somewhere: a key there is text, not a shortcut. */
export function typingIn(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('[contenteditable="true"], .cm-editor'));
}

/**
 * Something modal or a menu is open (a native dialog, the app's div-based
 * modals and portals, a file viewer, a menu or listbox): a key there
 * belongs to it.
 */
export function overlayOpen(): boolean {
  // `.fixed.inset-0`: the app's own full-screen overlays that carry no role (viewers, pickers).
  return !!document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]:not([hidden]), .fixed.inset-0');
}

/**
 * Whether a key press may run a one-key shortcut: no modifier, not a held
 * key's repeat, not typed into a field (the event's target or the focused
 * element), and no overlay open.
 */
export function pageShortcutAllowed(e: KeyboardEvent): boolean {
  return !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat
    && !typingIn(e.target) && !typingIn(document.activeElement) && !overlayOpen();
}

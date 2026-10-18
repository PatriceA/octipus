/**
 * The desktop app's companion surfaces (`web/src-tauri/src/companion.rs`):
 * the animated tray icon with its status line, and native notifications.
 * Desktop only; the Tauri API is imported on demand so it never lands in the
 * web bundle's hot path.
 */

export interface TrayUpdate {
  /** PNG frames of the icon animation. */
  frames: number[][];
  intervalMs: number;
  loop: boolean;
  /** Hover text and the first line of the tray menu. */
  status: string;
}

export async function updateTray(update: TrayUpdate): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('companion_update', {
    frames: update.frames,
    intervalMs: update.intervalMs,
    looping: update.loop,
    status: update.status,
  });
}

/** A native notification. Muting from the tray menu is enforced on the Rust side. */
export async function notifyDesktop(title: string, body: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('companion_notify', { title, body });
}

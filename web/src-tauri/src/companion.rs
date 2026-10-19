//! The companion outside the window: the tray icon, its menu, and native
//! notifications.
//!
//! The tray icon is the user's own companion, animated by state (working,
//! waiting for an answer, done, dozing…). The webview draws the frames from
//! the saved appearance (`web/lib/companion-presence.tsx`) and hands them over
//! with `companion_update`; a thread here flips through them, so the icon
//! keeps moving while the window is hidden. The menu shows what the companion
//! is doing and whether the backend server is up, starts a local server when
//! it is down, and holds the per-computer switches: notifications, start at
//! login, and keep running when the window closes.

use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_store::StoreExt as _;

use crate::{read_backend_url, SETTINGS_STORE};

const TRAY_ID: &str = "companion";
const MAIN_WINDOW: &str = "main";
const NOTIFICATIONS_MUTED_KEY: &str = "notificationsMuted";
const CLOSE_TO_TRAY_KEY: &str = "closeToTray";
/// How often the server status in the menu is re-checked.
const SERVER_POLL: Duration = Duration::from_secs(10);
const MAX_FRAMES: usize = 16;
const MAX_FRAME_BYTES: usize = 256 * 1024;
/// Linux tray icons are files handed to the panel; faster flips flicker there.
#[cfg(target_os = "linux")]
const MIN_FRAME_MS: u64 = 350;
#[cfg(not(target_os = "linux"))]
const MIN_FRAME_MS: u64 = 80;

/// Menu items that change after startup, and the current animation's
/// generation: bumping it stops the previous animation thread.
pub struct Companion {
    generation: AtomicU64,
    status: MenuItem<Wry>,
    server: MenuItem<Wry>,
    start_server: MenuItem<Wry>,
}

fn store_flag(app: &AppHandle, key: &str, default: bool) -> bool {
    match app.store(SETTINGS_STORE) {
        Ok(store) => store.get(key).and_then(|v| v.as_bool()).unwrap_or(default),
        Err(e) => {
            log::warn!("settings store unreadable, using default for {key}: {e}");
            default
        }
    }
}

fn set_store_flag(app: &AppHandle, key: &str, value: bool) {
    let saved = app.store(SETTINGS_STORE).and_then(|store| {
        store.set(key, value);
        store.save()
    });
    if let Err(e) = saved {
        log::warn!("could not persist {key}: {e}");
        notify(app, "Octipus could not save a setting", &format!("{key} will reset when the app restarts: {e}"));
    }
}

/// Closing the main window hides it to the tray unless the user turned that off.
pub fn close_to_tray(app: &AppHandle) -> bool {
    store_flag(app, CLOSE_TO_TRAY_KEY, true)
}

pub fn show_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("no main window to show");
        return;
    };
    for result in [window.unminimize(), window.show(), window.set_focus()] {
        if let Err(e) = result {
            log::warn!("could not bring the main window forward: {e}");
        }
    }
}

pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(e) = window.hide() {
            log::warn!("could not hide the main window: {e}");
        }
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(max - 1).collect();
    clipped.push('…');
    clipped
}

/// A native notification, unless muted from the tray menu.
fn notify(app: &AppHandle, title: &str, body: &str) {
    if store_flag(app, NOTIFICATIONS_MUTED_KEY, false) {
        return;
    }
    if let Err(e) = app.notification().builder().title(clip(title, 80)).body(clip(body, 240)).show() {
        log::warn!("notification failed: {e}");
    }
}

/// Build the tray icon and its menu, and start watching the server.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Octipus", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Octipus", true, None::<&str>)?;
    let server = MenuItem::with_id(app, "server", "Server: checking…", false, None::<&str>)?;
    let start_server = MenuItem::with_id(app, "start-server", "Start local server", false, None::<&str>)?;
    let notifications = CheckMenuItem::with_id(
        app, "notifications", "Notifications", true, !store_flag(app, NOTIFICATIONS_MUTED_KEY, false), None::<&str>,
    )?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or_else(|e| {
        log::warn!("could not read the start-at-login setting: {e}");
        false
    });
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart_on, None::<&str>)?;
    let keep = CheckMenuItem::with_id(app, "keep", "Keep running when the window closes", true, close_to_tray(app), None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Octipus", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[
        &status,
        &PredefinedMenuItem::separator(app)?,
        &open,
        &server,
        &start_server,
        &PredefinedMenuItem::separator(app)?,
        &notifications,
        &autostart,
        &keep,
        &PredefinedMenuItem::separator(app)?,
        &quit,
    ])?;

    let icon = app.default_window_icon().cloned().ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Octipus")
        .menu(&menu)
        // Windows and Linux: click opens the window, right-click the menu.
        // macOS: a menu-bar item opens its menu on click.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "start-server" => start_local_server(app),
            "notifications" => match notifications.is_checked() {
                Ok(on) => set_store_flag(app, NOTIFICATIONS_MUTED_KEY, !on),
                Err(e) => log::warn!("could not read the notifications toggle: {e}"),
            },
            "autostart" => toggle_autostart(app, &autostart),
            "keep" => match keep.is_checked() {
                Ok(on) => set_store_flag(app, CLOSE_TO_TRAY_KEY, on),
                Err(e) => log::warn!("could not read the keep-running toggle: {e}"),
            },
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    app.manage(Companion { generation: AtomicU64::new(0), status, server, start_server });
    watch_server(app.clone());
    Ok(())
}

fn toggle_autostart(app: &AppHandle, item: &CheckMenuItem<Wry>) {
    let wanted = match item.is_checked() {
        Ok(on) => on,
        Err(e) => {
            log::warn!("could not read the start-at-login toggle: {e}");
            return;
        }
    };
    let launcher = app.autolaunch();
    let result = if wanted { launcher.enable() } else { launcher.disable() };
    if let Err(e) = result {
        notify(app, "Could not change Start at login", &e.to_string());
        if let Err(e) = item.set_checked(!wanted) {
            log::warn!("could not reset the start-at-login toggle: {e}");
        }
    }
}

/// The current companion animation and status line, from the webview.
#[tauri::command]
pub fn companion_update(
    app: AppHandle,
    companion: State<'_, Companion>,
    frames: Vec<Vec<u8>>,
    interval_ms: u64,
    looping: bool,
    status: String,
) -> Result<(), String> {
    if frames.is_empty() || frames.len() > MAX_FRAMES {
        return Err(format!("expected 1–{MAX_FRAMES} frames, got {}", frames.len()));
    }
    if frames.iter().any(|frame| frame.len() > MAX_FRAME_BYTES) {
        return Err(format!("a frame is over {MAX_FRAME_BYTES} bytes"));
    }
    let images = frames
        .iter()
        .map(|png| Image::from_bytes(png))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("a frame is not a PNG: {e}"))?;
    let tray = app.tray_by_id(TRAY_ID).ok_or("the tray icon is not available")?;
    let status = clip(&status, 120);
    tray.set_tooltip(Some(&status)).map_err(|e| format!("could not set the tray tooltip: {e}"))?;
    companion.status.set_text(&status).map_err(|e| format!("could not set the tray status: {e}"))?;
    tray.set_icon(Some(images[0].clone())).map_err(|e| format!("could not set the tray icon: {e}"))?;

    let generation = companion.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if images.len() > 1 {
        let interval = Duration::from_millis(interval_ms.clamp(MIN_FRAME_MS, 5_000));
        std::thread::spawn(move || animate(app, images, interval, looping, generation));
    }
    Ok(())
}

/// Flip through the frames until a newer update supersedes this one.
fn animate(app: AppHandle, images: Vec<Image<'static>>, interval: Duration, looping: bool, generation: u64) {
    let mut index = 0;
    loop {
        std::thread::sleep(interval);
        if app.state::<Companion>().generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if !looping && index == images.len() - 1 {
            return;
        }
        index = (index + 1) % images.len();
        let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
        if let Err(e) = tray.set_icon(Some(images[index].clone())) {
            log::warn!("tray animation stopped: {e}");
            return;
        }
    }
}

/// A native notification from the webview: a turn finished, failed, or needs an answer.
#[tauri::command]
pub fn companion_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    if store_flag(&app, NOTIFICATIONS_MUTED_KEY, false) {
        return Ok(());
    }
    app.notification()
        .builder()
        .title(clip(&title, 80))
        .body(clip(&body, 240))
        .show()
        .map_err(|e| format!("notification failed: {e}"))
}

/// Host and port of an http(s) base URL.
fn backend_addr(url: &str) -> Option<(String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let default_port = match scheme {
        "http" => 80,
        "https" => 443,
        _ => return None,
    };
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, after) = bracketed.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None if after.is_empty() => default_port,
            None => return None,
        };
        return Some((host.to_string(), port));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (authority, default_port),
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
}

fn is_local(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn reachable(host: &str, port: u16) -> bool {
    match (host, port).to_socket_addrs() {
        Ok(mut addrs) => addrs.any(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(2)).is_ok()),
        Err(_) => false,
    }
}

/// Keep the menu's server line current, and offer to start a local server that is down.
fn watch_server(app: AppHandle) {
    std::thread::spawn(move || {
        let mut was_up: Option<bool> = None;
        loop {
            let url = read_backend_url(&app);
            let (text, up, can_start) = match backend_addr(&url) {
                Some((host, port)) => {
                    let up = reachable(&host, port);
                    let local = is_local(&host);
                    let text = match (up, local) {
                        (true, true) => format!("Server: running on port {port}"),
                        (true, false) => format!("Server: connected to {host}"),
                        (false, true) => "Server: not running".to_string(),
                        (false, false) => format!("Server: {host} not reachable"),
                    };
                    (text, up, !up && local)
                }
                None => (format!("Server: invalid address {url}"), false, false),
            };
            let companion = app.state::<Companion>();
            if let Err(e) = companion.server.set_text(&text) {
                log::warn!("could not update the server status: {e}");
            }
            if let Err(e) = companion.start_server.set_enabled(can_start) {
                log::warn!("could not update the start-server item: {e}");
            }
            // Coming back up after being down is worth a word; the first check is not.
            if was_up == Some(false) && up {
                notify(&app, "Octipus server is back", &text);
            }
            was_up = Some(up);
            std::thread::sleep(SERVER_POLL);
        }
    });
}

/// The `octi` launcher of this installation: next to a dev build, the
/// installer's default location, OCTIPUS_HOME, or PATH.
fn octi_launcher(app: &AppHandle) -> Option<PathBuf> {
    let script = if cfg!(windows) { "octi.cmd" } else { "octi" };
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("OCTIPUS_HOME") {
        roots.push(PathBuf::from(home));
    }
    // A dev build runs from <checkout>/web/src-tauri/target/…
    if let Ok(exe) = std::env::current_exe() {
        roots.extend(exe.ancestors().map(Path::to_path_buf));
    }
    if let Ok(home) = app.path().home_dir() {
        roots.push(home.join(".octipus").join("app"));
    }
    let in_checkout = roots.into_iter().map(|root| root.join("bin").join(script)).find(|path| path.is_file());
    in_checkout.or_else(|| {
        std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|dir| dir.join(script)).find(|p| p.is_file()))
    })
}

/// `octi start` with no client: brings up the backend and returns.
fn start_local_server(app: &AppHandle) {
    let Some(launcher) = octi_launcher(app) else {
        notify(app, "Could not find octi", "Start the server from a terminal with: octi start");
        return;
    };
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new("cmd");
        command.arg("/C").arg(&launcher).arg("start").creation_flags(CREATE_NO_WINDOW);
        command
    };
    // A desktop launcher (Finder, a .desktop file) gives apps a bare PATH
    // without node; a login shell reads the user's profile first.
    #[cfg(not(windows))]
    let mut command = {
        let shell = std::env::var_os("SHELL").unwrap_or_else(|| "/bin/sh".into());
        let mut command = Command::new(shell);
        command.arg("-lc").arg("exec \"$0\" start").arg(&launcher);
        command
    };
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => {
            notify(app, "Could not start the Octipus server", &format!("{}: {e}", launcher.display()));
            return;
        }
    };
    if let Err(e) = app.state::<Companion>().server.set_text("Server: starting…") {
        log::warn!("could not update the server status: {e}");
    }
    let app = app.clone();
    std::thread::spawn(move || match child.wait() {
        Ok(status) if status.success() => {}
        Ok(status) => notify(&app, "The Octipus server did not start", &format!("octi start exited with {status}. Run it in a terminal to see why.")),
        Err(e) => log::warn!("lost track of octi start: {e}"),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_addr_reads_host_and_port() {
        assert_eq!(backend_addr("http://127.0.0.1:3005"), Some(("127.0.0.1".into(), 3005)));
        assert_eq!(backend_addr("https://octi.example.com/api"), Some(("octi.example.com".into(), 443)));
        assert_eq!(backend_addr("http://user@localhost"), Some(("localhost".into(), 80)));
        assert_eq!(backend_addr("http://[::1]:3005/"), Some(("::1".into(), 3005)));
        assert_eq!(backend_addr("ftp://host"), None);
        assert_eq!(backend_addr("http://host:port"), None);
        assert_eq!(backend_addr("http://:3005"), None);
    }

    #[test]
    fn local_hosts_are_the_loopback_names() {
        assert!(is_local("localhost") && is_local("127.0.0.1") && is_local("::1"));
        assert!(!is_local("192.168.1.10"));
    }

    #[test]
    fn clip_counts_characters_not_bytes() {
        assert_eq!(clip("héllo", 5), "héllo");
        assert_eq!(clip("héllo wörld", 6), "héllo…");
    }
}

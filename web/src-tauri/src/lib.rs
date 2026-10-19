use tauri_plugin_store::StoreExt;
#[cfg(desktop)]
use tauri::Manager as _;

#[cfg(desktop)]
mod companion;

/// Persisted-settings file (tauri-plugin-store) and the key holding the base
/// URL of the backend the desktop client talks to. The desktop app does NOT
/// run its own backend — it is a thin client that connects to any Octipus
/// backend (local `octi start`, a LAN host, or a remote deployment).
pub(crate) const SETTINGS_STORE: &str = "settings.json";
const BACKEND_URL_KEY: &str = "backendUrl";
const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:3005";
/// Passed by the start-at-login entry, so the app starts hidden in the tray.
#[cfg(desktop)]
const STARTED_AT_LOGIN_ARG: &str = "--minimized";

/// Read the user-configured backend base URL from the store, falling back to
/// the local default. A missing/garbled preference must never block app start,
/// so we silently fall back rather than failing loud.
pub(crate) fn read_backend_url(app: &tauri::AppHandle) -> String {
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return DEFAULT_BACKEND_URL.to_string();
    };
    store
        .get(BACKEND_URL_KEY)
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .unwrap_or_else(|| DEFAULT_BACKEND_URL.to_string())
}

/// Frontend reads this at startup to learn which backend origin to call.
#[tauri::command]
fn get_backend_url(app: tauri::AppHandle) -> String {
    read_backend_url(&app)
}

/// Persist a new backend URL (the connection screen). Validated to be an
/// absolute http(s) URL so the frontend can't store something it can't reach.
#[tauri::command]
fn set_backend_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim().trim_end_matches('/');
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("backend URL must start with http:// or https://".into());
    }
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("failed to open settings store: {e}"))?;
    store.set(BACKEND_URL_KEY, trimmed);
    store
        .save()
        .map_err(|e| format!("failed to persist settings: {e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // A second launch (a login item, a double-click while it hides in the
    // tray) brings the running app forward instead of starting another one.
    // Registered first, as the plugin requires.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| companion::show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![STARTED_AT_LOGIN_ARG]),
        ))
        .on_window_event(|window, event| {
            // Closing the window keeps the companion in the tray, still notifying.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && companion::close_to_tray(window.app_handle()) {
                    api.prevent_close();
                    companion::hide_main(window.app_handle());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_backend_url,
            set_backend_url,
            companion::companion_update,
            companion::companion_notify
        ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![get_backend_url, set_backend_url]);

    let app = builder
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            log::info!("desktop client targeting backend {}", read_backend_url(app.handle()));
            #[cfg(desktop)]
            {
                companion::setup(app.handle())?;
                // Started at login: straight to the tray.
                if std::env::args().any(|arg| arg == STARTED_AT_LOGIN_ARG) {
                    companion::hide_main(app.handle());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // macOS: clicking the Dock icon of an app hidden to the tray shows it again.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            companion::show_main(_app);
        }
    });
}

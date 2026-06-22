use tauri_plugin_store::StoreExt;

/// Persisted-settings file (tauri-plugin-store) and the key holding the base
/// URL of the backend the desktop client talks to. The desktop app does NOT
/// run its own backend — it is a thin client that connects to any Octipus
/// backend (local `octi start`, a LAN host, or a remote deployment).
const SETTINGS_STORE: &str = "settings.json";
const BACKEND_URL_KEY: &str = "backendUrl";
const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:3005";

/// Read the user-configured backend base URL from the store, falling back to
/// the local default. A missing/garbled preference must never block app start,
/// so we silently fall back rather than failing loud.
fn read_backend_url(app: &tauri::AppHandle) -> String {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![get_backend_url, set_backend_url])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            log::info!("desktop client targeting backend {}", read_backend_url(app.handle()));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

use std::sync::Mutex;

use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_store::StoreExt;

/// Persisted-settings file (tauri-plugin-store) and the key holding the port
/// the user picks at setup. Defaults to the backend's own default (3005).
const SETTINGS_STORE: &str = "settings.json";
const PORT_KEY: &str = "backendPort";
const DEFAULT_PORT: u16 = 3005;

/// Holds the running backend sidecar so we can kill it on exit.
#[derive(Default)]
struct BackendProcess(Mutex<Option<CommandChild>>);

/// Read the user-configured backend port from the store, falling back to the
/// default. Invalid/out-of-range values are ignored rather than failing loud,
/// because a missing/garbled preference must never block app start.
fn read_backend_port(app: &tauri::AppHandle) -> u16 {
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return DEFAULT_PORT;
    };
    store
        .get(PORT_KEY)
        .and_then(|v| v.as_u64())
        .filter(|p| *p >= 1 && *p <= u16::MAX as u64)
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_PORT)
}

/// Spawn the backend sidecar on `port`. The sidecar is the binary produced by
/// `scripts/build-sidecar.ts` and declared in tauri.conf.json `externalBin`.
///
/// We pass the port via `API_PORT` (the backend reads `API_PORT`/`PORT`). We
/// also default `STORAGE_MODE=embedded` so a fresh desktop install runs with
/// no external services — but only when the launching environment hasn't
/// already set it, so a user pointing at external pgvector/Valkey (the
/// production setup) keeps full control.
fn spawn_backend(app: &tauri::AppHandle, port: u16) -> Result<CommandChild, String> {
    let mut command = app
        .shell()
        .sidecar("octipus-server")
        .map_err(|e| format!("failed to resolve backend sidecar: {e}"))?
        .env("API_PORT", port.to_string());

    if std::env::var_os("STORAGE_MODE").is_none() {
        command = command.env("STORAGE_MODE", "embedded");
    }

    let (_rx, child) = command
        .spawn()
        .map_err(|e| format!("failed to spawn backend sidecar: {e}"))?;
    log::info!("backend sidecar started on port {port}");
    Ok(child)
}

/// Frontend reads this at startup to learn which loopback port to call.
#[tauri::command]
fn get_backend_port(app: tauri::AppHandle) -> u16 {
    read_backend_port(&app)
}

/// Persist a new backend port (setup UI). Takes effect on next launch; we do
/// not hot-restart the sidecar here to keep the contract simple.
#[tauri::command]
fn set_backend_port(app: tauri::AppHandle, port: u16) -> Result<(), String> {
    if port == 0 {
        return Err("port must be between 1 and 65535".into());
    }
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("failed to open settings store: {e}"))?;
    store.set(PORT_KEY, port);
    store
        .save()
        .map_err(|e| format!("failed to persist settings: {e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(BackendProcess::default())
        .invoke_handler(tauri::generate_handler![get_backend_port, set_backend_port])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let handle = app.handle();
            let port = read_backend_port(handle);
            match spawn_backend(handle, port) {
                Ok(child) => {
                    let state: State<BackendProcess> = app.state();
                    *state.0.lock().unwrap() = Some(child);
                }
                // Fail loud in the log, but don't prevent the window from
                // opening — the user may be running the backend separately.
                Err(e) => log::error!("{e}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Tear the sidecar down with the app so it starts/stops together.
            if let RunEvent::ExitRequested { .. } = event {
                let state: State<BackendProcess> = app_handle.state();
                // Bind the taken child first so the MutexGuard temporary is
                // dropped before `state` goes out of scope (avoids E0597).
                let child = state.0.lock().unwrap().take();
                if let Some(child) = child {
                    let _ = child.kill();
                    log::info!("backend sidecar stopped");
                }
            }
        });
}

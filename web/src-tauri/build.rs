// The app's own commands are governed by capabilities like plugin commands
// are: with an app manifest, a command no capability grants is refused
// (capabilities/default.json grants these to the main window). Without
// one, Tauri lets any local content call every registered command.
fn main() {
  tauri_build::try_build(
    tauri_build::Attributes::new().app_manifest(
      tauri_build::AppManifest::new().commands(&["get_backend_url", "set_backend_url", "companion_update", "companion_notify"]),
    ),
  )
  .expect("failed to run tauri-build");
}

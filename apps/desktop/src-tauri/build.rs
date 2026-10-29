fn main() {
    // The UI is served by the gateway (a remote origin to Tauri), so the app's own command needs
    // a permission that the capability grants explicitly.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["open_session_window", "notify_session", "set_attention", "render_svg_pdf", "print_svg"])),
    )
    .expect("failed to run tauri-build");
}

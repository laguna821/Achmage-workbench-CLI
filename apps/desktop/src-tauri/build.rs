fn main() {
    // The UI is served by the gateway (a remote origin to Tauri), so the app's own command needs
    // a permission that the capability grants explicitly.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["host_credential", "open_session_window", "notify_session", "notify_attention", "take_open_attention", "set_attention", "take_open_files", "render_svg_pdf", "print_svg", "render_html_pdf", "print_html", "office_executor_output", "office_cli_job", "office_cli_write", "office_cli_done", "office_cli_trace", "office_browser", "shared_browser"])),
    )
    .expect("failed to run tauri-build");
    // tauri-winres links its manifest to bins, not Cargo examples. The native
    // browser example also imports TaskDialogIndirect, which requires the same
    // Common Controls v6 manifest before Windows can even enter main().
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let resource = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("resource.lib");
        assert!(resource.is_file(), "tauri-build did not generate the Windows app resource");
        println!("cargo:rustc-link-arg-examples={}", resource.display());
    }
}

// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--reveal-ai-secrets") {
        std::process::exit(achmage_workbench_lib::reveal_ai_secrets());
    }
    if std::env::args().nth(1).as_deref() == Some("--office-secret-key") {
        std::process::exit(achmage_workbench_lib::office_secrets::run());
    }
    if std::env::args().nth(1).as_deref() == Some("--pty-worker") {
        std::process::exit(achmage_workbench_lib::terminal_worker::run());
    }
    achmage_workbench_lib::run();
}

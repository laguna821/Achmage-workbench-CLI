// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--host-runtime") {
        std::process::exit(achmage_workbench_lib::host_runtime::run(false));
    }
    if std::env::args().nth(1).as_deref() == Some("--host-service") {
        std::process::exit(achmage_workbench_lib::host_runtime::run(true));
    }
    if std::env::args().nth(1).as_deref() == Some("--office-executor") {
        std::process::exit(achmage_workbench_lib::office_executor::run());
    }
    if std::env::args().nth(1).as_deref() == Some("--search-worker") {
        std::process::exit(achmage_workbench_lib::search_worker::run());
    }
    if std::env::args().nth(1).as_deref() == Some("--office-font-catalog") {
        std::process::exit(achmage_workbench_lib::office_fonts::run());
    }
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

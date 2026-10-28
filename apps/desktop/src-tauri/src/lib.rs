use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;

/// Closing the window only hides it (work goes on, PRD "트레이로 이동, 작업 유지"); said once.
static HIDDEN_ONCE: AtomicBool = AtomicBool::new(false);

/// The local gateway (Node) owns engine processes and state; the window only shows its UI.
struct Gateway(Mutex<Option<Child>>);

struct Ready {
    url: String,
    token: String,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

/// Launchers start apps with a minimal PATH; engines need the user's usual tool locations.
fn engine_path() -> String {
    let mut parts: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    for extra in [home().join(".local/bin"), home().join(".cargo/bin")] {
        let extra = extra.to_string_lossy().to_string();
        if !parts.contains(&extra) {
            parts.push(extra);
        }
    }
    parts.join(":")
}

fn gateway_command(app: &tauri::AppHandle) -> Command {
    let node = std::env::var("WORKBENCH_NODE").unwrap_or_else(|_| "node".into());
    let mut command = Command::new(node);
    // Bundles (AppImage) use the resource dir; a plain install keeps host/ and web/ next to the binary.
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    let bundled = [app.path().resource_dir().ok(), exe_dir]
        .into_iter()
        .flatten()
        .map(|dir| (dir.join("host/host.mjs"), dir.join("web")))
        .find(|(host, _)| host.exists());
    match bundled {
        Some((host, web)) => {
            command.arg(host).env("WORKBENCH_WEB_DIR", web);
        }
        None if cfg!(debug_assertions) => {
            // Development only: run the gateway straight from the repository sources.
            let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            command
                .arg(repo.join("apps/host/src/main.ts"))
                .env("WORKBENCH_WEB_DIR", repo.join("apps/web/dist"));
        }
        None => {
            // Release builds never fall back to a source checkout; this fails visibly at spawn.
            command.arg("host/host.mjs");
        }
    }
    command
        .env("PATH", engine_path())
        .env("WORKBENCH_EXIT_ON_STDIN_CLOSE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    command
}

fn start_gateway(app: &tauri::AppHandle) -> Result<(Child, Ready), String> {
    let mut child = gateway_command(app)
        .spawn()
        .map_err(|error| format!("Node.js를 실행하지 못했습니다 ({error}). Node 24 이상이 필요합니다."))?;
    let stdout = child.stdout.take().ok_or("게이트웨이 출력을 읽지 못했습니다.")?;
    let mut lines = BufReader::new(stdout).lines();
    let ready = loop {
        match lines.next() {
            Some(Ok(line)) => {
                if let Some(json) = line.strip_prefix("WORKBENCH_READY ") {
                    let value: serde_json::Value =
                        serde_json::from_str(json).map_err(|error| error.to_string())?;
                    break Ready {
                        url: value["url"].as_str().unwrap_or_default().to_string(),
                        token: value["token"].as_str().unwrap_or_default().to_string(),
                    };
                }
            }
            _ => {
                let _ = child.kill();
                return Err("게이트웨이가 시작 중에 종료되었습니다.".into());
            }
        }
    };
    // Keep draining stdout so the gateway never blocks on a full pipe.
    std::thread::spawn(move || for _ in lines {});
    Ok((child, ready))
}

fn open_main_window(app: &tauri::AppHandle, ready: &Ready) -> tauri::Result<()> {
    let mut url = url::Url::parse(&ready.url).expect("gateway url");
    url.query_pairs_mut().append_pair("token", &ready.token);
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Achmage Workbench")
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 560.0)
        // Files dropped from the desktop reach the page as ordinary drops (attachments, images).
        .disable_drag_drop_handler()
        .build()?;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The tray entry: open the window again, or quit (which stops the gateway and its engines).
/// Linux trays (AppIndicator) only open the menu, so "열기" is a menu item, not a click.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Achmage Workbench 열기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "끝내기 (진행 중인 응답도 멈춤)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Achmage Workbench")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn stop_gateway(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Gateway>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            // Closing stdin asks the gateway to shut down cleanly; kill only if it lingers.
            drop(child.stdin.take());
            for _ in 0..30 {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    if !HIDDEN_ONCE.swap(true, Ordering::SeqCst) {
                        let _ = window
                            .app_handle()
                            .notification()
                            .builder()
                            .title("Achmage Workbench는 계속 일합니다")
                            .body("창만 닫았습니다. 진행 중인 응답은 이어지고, 끝나면 알려 드립니다. 트레이의 Achmage에서 다시 열거나 끝낼 수 있습니다.")
                            .show();
                    }
                }
            }
        })
        .manage(Gateway(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            match start_gateway(&handle) {
                Ok((child, ready)) => {
                    *handle.state::<Gateway>().0.lock().unwrap() = Some(child);
                    open_main_window(&handle, &ready)?;
                    // Without a tray (no StatusNotifier host) the app still works; launching it
                    // again shows the hidden window (single instance).
                    if let Err(error) = build_tray(&handle) {
                        eprintln!("tray unavailable: {error}");
                    }
                }
                Err(message) => {
                    handle
                        .dialog()
                        .message(message)
                        .title("Achmage Workbench를 시작하지 못했습니다")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    handle.exit(1);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Achmage Workbench");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_gateway(handle);
        }
    });
}

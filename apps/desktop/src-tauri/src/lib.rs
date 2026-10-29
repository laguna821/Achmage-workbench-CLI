use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_notification::NotificationExt;
mod office_output;

/// Closing the window only hides it (work goes on, PRD "트레이로 이동, 작업 유지"); said once.
static HIDDEN_ONCE: AtomicBool = AtomicBool::new(false);

/// The local gateway (Node) owns engine processes and state; the window only shows its UI.
struct Gateway(Mutex<Option<Child>>);

struct Ready {
    url: String,
    token: String,
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Launchers start apps with a minimal PATH; engines need the user's usual tool locations.
fn engine_path() -> std::ffi::OsString {
    let mut parts: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    let mut extras = vec![home().join(".local/bin"), home().join(".cargo/bin")];
    if cfg!(target_os = "macos") {
        // Apps opened from Finder get only the system PATH; Homebrew and npm keep tools here.
        extras.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            extras.push(PathBuf::from(appdata).join("npm"));
        }
    }
    for extra in extras {
        if !parts.contains(&extra) {
            parts.push(extra);
        }
    }
    std::env::join_paths(parts).unwrap_or_default()
}

/// Where the app's own files sit: the resource dir of a bundle, or next to the binary.
fn app_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(PathBuf::from));
    // The AppImage keeps the shipped document apps in usr/share/achmage-workbench (beside
    // usr/bin): linuxdeploy does not walk that folder, so their own old libraries are left alone.
    let share = exe_dir
        .as_ref()
        .map(|dir| dir.join("..").join("share").join("achmage-workbench"))
        .filter(|dir| dir.is_dir());
    [app.path().resource_dir().ok(), exe_dir, share].into_iter().flatten().collect()
}

/// The Node.js that runs the gateway: WORKBENCH_NODE, else the one an installer brought along
/// (node/ beside the app's files), else the system's.
fn node_binary(app: &tauri::AppHandle) -> PathBuf {
    if let Some(node) = std::env::var_os("WORKBENCH_NODE") {
        return PathBuf::from(node);
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    app_dirs(app)
        .into_iter()
        .map(|dir| dir.join("node").join(name))
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from(name))
}

fn gateway_command(app: &tauri::AppHandle) -> Command {
    let mut command = Command::new(node_binary(app));
    #[cfg(windows)]
    {
        // No console window for the gateway.
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    // Bundles (AppImage) use the resource dir; a plain install keeps host/ and web/ next to the binary.
    let bundled = app_dirs(app)
        .into_iter()
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
    // The tools shipped with the app (kordoc, IeumOffice, npm) sit in the resource folder.
    if let Ok(dirs) = std::env::join_paths(app_dirs(app)) {
        command.env("WORKBENCH_RESOURCES_DIR", dirs);
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

/// A session id is used as part of a window label and a URL: only the characters ids are made of.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// "새 창으로 떼어 내기": the same UI in another window, showing one session (`?session=`). The
/// window manager places it (niri tiles it next to the others). Asking again brings it forward.
#[tauri::command]
async fn open_session_window(app: tauri::AppHandle, session_id: String, title: String) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("세션을 알아볼 수 없습니다.".into());
    }
    let label = format!("session-{session_id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    let ready = app.try_state::<Ready>().ok_or("게이트웨이가 아직 준비되지 않았습니다.")?;
    let mut url = url::Url::parse(&ready.url).map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("token", &ready.token)
        .append_pair("session", &session_id);
    let name: String = title.trim().chars().take(60).collect();
    WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title(if name.is_empty() { "Achmage Workbench".to_string() } else { format!("{name} — Achmage") })
        .inner_size(760.0, 860.0)
        .min_inner_size(420.0, 480.0)
        // Like the main window: files dropped from the desktop reach the page.
        .disable_drag_drop_handler()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
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

/// The tray's first line: how many sessions wait for the user ("확인 필요 N"); it opens the first.
struct Attention(Mutex<Option<MenuItem<tauri::Wry>>>);

/// The tray entry: what waits, open the window again, or quit (which stops the gateway and its
/// engines). Linux trays (AppIndicator) only open the menu, so "열기" is a menu item, not a click.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let attention = MenuItem::with_id(app, "attention", "확인할 것 없음", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Achmage Workbench 열기", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "끝내기 (진행 중인 응답도 멈춤)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&attention, &open, &quit])?;
    app.manage(Attention(Mutex::new(Some(attention))));
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Achmage Workbench")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "attention" => {
                show_main(app);
                let _ = app.emit_to("main", "workbench://open-attention", ());
            }
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

/// The number of sessions waiting for the user, from the main window: the tray's first line and
/// its tooltip follow it.
#[tauri::command]
fn set_attention(app: tauri::AppHandle, count: u32) {
    if let Some(state) = app.try_state::<Attention>() {
        if let Some(item) = state.0.lock().unwrap().as_ref() {
            let _ = item.set_text(if count > 0 { format!("확인 필요 {count} · 열기") } else { "확인할 것 없음".to_string() });
            let _ = item.set_enabled(count > 0);
        }
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(if count > 0 { format!("Achmage Workbench · 확인 필요 {count}") } else { "Achmage Workbench".to_string() }));
    }
}

/// An OS notification that opens its session when clicked: freedesktop notification servers
/// report the click as the "default" action. Elsewhere the UI falls back to the notification
/// plugin (shown, but a click does not say which session).
#[tauri::command]
fn notify_session(app: tauri::AppHandle, title: String, body: String, session_id: String) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("세션을 알아볼 수 없습니다.".into());
    }
    #[cfg(target_os = "linux")]
    {
        let handle = notify_rust::Notification::new()
            .appname("Achmage Workbench")
            .summary(&title)
            .body(&body)
            .icon("achmage-workbench")
            .action("default", "열기")
            .show()
            .map_err(|error| error.to_string())?;
        // Waits until the notification is clicked or goes away (one short-lived thread each).
        std::thread::spawn(move || {
            handle.wait_for_action(|action| {
                if action == "default" {
                    show_main(&app);
                    let _ = app.emit_to("main", "workbench://open-session", session_id.clone());
                }
            });
        });
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, title, body);
        Err("unsupported".into())
    }
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
        .invoke_handler(tauri::generate_handler![open_session_window, notify_session, set_attention, office_output::render_svg_pdf, office_output::print_svg])
        .manage(office_output::PrintJobs::default())
        .register_uri_scheme_protocol("workbench-print", |ctx, request| {
            let id = request.uri().path().trim_start_matches('/');
            let jobs = ctx.app_handle().state::<office_output::PrintJobs>();
            let body = jobs.0.lock().unwrap().get(id).cloned();
            #[cfg(debug_assertions)]
            eprintln!("[office-output] serve {id}: {}", body.is_some());
            tauri::http::Response::builder().status(if body.is_some() { 200 } else { 404 })
                .header("Content-Type", "text/html; charset=utf-8")
                .header("Cache-Control", "no-store")
                .header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
                .body(body.unwrap_or_else(|| "인쇄 창이 닫혔습니다.".into()).into_bytes()).unwrap()
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if window.label().starts_with("print-") { window.app_handle().state::<office_output::PrintJobs>().0.lock().unwrap().remove(window.label()); }
            }
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
                    // Session windows open on the same gateway, with the same token.
                    handle.manage(ready);
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

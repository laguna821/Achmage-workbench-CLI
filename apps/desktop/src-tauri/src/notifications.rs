use std::sync::Mutex;
use tauri::{Emitter, Manager};

fn body_for(kind: &str) -> Option<&'static str> {
    match kind { "completed" => Some("작업이 완료되었습니다."), "failed" => Some("작업을 마치지 못했습니다."), "input_needed" => Some("확인이 필요한 작업이 있습니다."), _ => None }
}

fn notification(body: &str) -> Result<notify_rust::NotificationHandle, String> {
    #[cfg(target_os = "macos")]
    {
        static APPLICATION: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
        APPLICATION.get_or_init(|| notify_rust::set_application("kr.achmage.workbench").map_err(|error| error.to_string())).clone()?;
    }
    let mut notification = notify_rust::Notification::new();
    notification.appname("Achmage Workbench").summary("Achmage Workbench").body(body).icon("achmage-workbench").action("default", "열기");
    #[cfg(target_os = "windows")]
    notification.app_id("kr.achmage.workbench");
    notification.show().map_err(|error| error.to_string())
}

fn activated(response: &notify_rust::NotificationResponse) -> bool {
    matches!(response, notify_rust::NotificationResponse::Default) || matches!(response, notify_rust::NotificationResponse::Action(action) if action == "default")
}

/** Called before creating the Tauri UI. This owned helper keeps only the original OS callback alive. */
pub fn helper(args: &[String]) -> Option<i32> {
    if args.first().map(String::as_str) != Some("--notify-attention") { return None; }
    if args.len() != 3 || !valid_id(&args[1]) { return Some(2); }
    let Some(body) = body_for(&args[2]) else { return Some(2); };
    let id = args[1].clone();
    let run = move || -> i32 {
        use std::io::Write;
        let handle = match notification(body) { Ok(handle) => handle, Err(_) => { println!("unavailable"); let _ = std::io::stdout().flush(); return 1; } };
        // NSUserNotificationCenter submits inside wait_for_response; it offers no separate show receipt.
        println!("{}", if cfg!(target_os = "macos") { "queued" } else { "sent" }); let _ = std::io::stdout().flush();
        match handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
            if activated(response) {
                if let Some(binary) = std::env::var_os("APPIMAGE").filter(|value| !value.is_empty()).map(std::path::PathBuf::from).or_else(|| std::env::current_exe().ok()) { let _ = std::process::Command::new(binary).arg("--attention").arg(&id).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn(); }
            }
        }) { Ok(()) => 0, Err(_) => 1 }
    };
    #[cfg(target_os = "macos")]
    {
        use std::sync::{Arc, atomic::{AtomicBool, AtomicI32, Ordering}};
        let finished = Arc::new(AtomicBool::new(false)); let result = Arc::new(AtomicI32::new(0));
        let done = finished.clone(); let output = result.clone();
        std::thread::spawn(move || { output.store(run(), Ordering::Release); done.store(true, Ordering::Release); });
        let until = std::time::Instant::now() + std::time::Duration::from_secs(86400);
        while !finished.load(Ordering::Acquire) && std::time::Instant::now() < until {
            // The reused mac notification backend dispatches its delegate on the main run loop.
            unsafe { objc2_foundation::NSRunLoop::currentRunLoop().runUntilDate(&objc2_foundation::NSDate::dateWithTimeIntervalSinceNow(0.1)); }
        }
        Some(result.load(Ordering::Acquire))
    }
    #[cfg(not(target_os = "macos"))]
    { Some(run()) }
}

#[derive(Default)]
pub struct OpenAttention(pub Mutex<Option<String>>);

pub fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn argument(args: &[String]) -> Option<String> {
    if args.len() == 2 && args[0] == "--attention" && valid_id(&args[1]) { Some(args[1].clone()) } else { None }
}

pub fn open(app: &tauri::AppHandle, id: String) {
    if !valid_id(&id) { return; }
    *app.state::<OpenAttention>().0.lock().unwrap() = Some(id.clone());
    super::show_main(app);
    let _ = app.emit_to("main", "workbench://open-attention", id);
}

#[tauri::command]
pub fn take_open_attention(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    if window.label() != "main" { return Err("기본 창에서만 알림을 열 수 있습니다.".into()); }
    Ok(app.state::<OpenAttention>().0.lock().unwrap().take())
}

#[tauri::command]
pub fn notify_attention(app: tauri::AppHandle, webview: tauri::Webview, title: String, body: String, attention_id: String) -> Result<(), String> {
    if webview.label() != "main" { return Err("기본 앱에서만 시스템 알림을 요청할 수 있습니다.".into()); }
    if !valid_id(&attention_id) { return Err("알림 ID를 확인할 수 없습니다.".into()); }
    let _ = title;
    if !["completed", "failed", "input_needed"].iter().any(|kind| body_for(kind) == Some(body.as_str())) { return Err("일반 알림 문구만 사용할 수 있습니다.".into()); }
    let handle = notification(&body)?;
    std::thread::spawn(move || { let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| { if activated(response) { open(&app, attention_id); } }); });
    Ok(())
}

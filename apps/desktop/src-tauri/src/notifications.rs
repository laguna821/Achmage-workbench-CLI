use std::sync::Mutex;
use tauri::{Emitter, Manager};

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
pub fn notify_attention(app: tauri::AppHandle, title: String, body: String, attention_id: String) -> Result<(), String> {
    if !valid_id(&attention_id) { return Err("알림 ID를 확인할 수 없습니다.".into()); }
    #[cfg(target_os = "linux")]
    {
        let handle = notify_rust::Notification::new().appname("Achmage Workbench")
            .summary(&title).body(&body).icon("achmage-workbench").action("default", "열기")
            .show().map_err(|error| error.to_string())?;
        std::thread::spawn(move || handle.wait_for_action(|action| {
            if action == "default" { open(&app, attention_id.clone()); }
        }));
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, title, body);
        // The web Notification fallback can keep an exact click target on supported WebViews.
        Err("unsupported".into())
    }
}

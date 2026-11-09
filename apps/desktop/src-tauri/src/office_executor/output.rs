//! Only the trusted executor parent can call the existing Office output engines.
//! No filesystem path, shell or generic app command is exposed by this bridge.
use std::collections::HashMap;
use std::sync::Mutex;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Manager, ipc::{IpcResponse, InvokeResponseBody}};

enum Receipt { Pending(Value), Done(Value, Result<Value, String>) }
pub struct Outputs { parent: url::Url, receipts: Mutex<HashMap<String, Receipt>> }
impl Outputs { pub fn new(parent: url::Url) -> Self { Self { parent, receipts: Mutex::new(HashMap::new()) } } }

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Command {
    SvgPdf { job: crate::office_output::SvgJob },
    HtmlPdf { job: crate::office_html_output::HtmlJob },
    SvgPrint { job: crate::office_output::SvgJob },
    HtmlPrint { job: crate::office_html_output::HtmlJob },
    Browser { command: crate::office_browser::BrowserCommand },
}
fn bytes(response: tauri::ipc::Response) -> Result<Value, String> {
    match response.body().map_err(|_| "문서 출력 응답을 읽지 못했습니다.")? {
        InvokeResponseBody::Raw(value) => Ok(json!({ "base64": base64::engine::general_purpose::STANDARD.encode(value) })),
        _ => Err("문서 출력기가 바이트 응답을 반환하지 않았습니다.".into()),
    }
}
async fn wait_for_print_windows(app: &tauri::AppHandle) -> Result<(), String> {
    // Existing SVG preview and WebView2 ShowPrintUI return before the user closes
    // their window. Keep this request/process alive, without opening a second UI.
    for (label, window) in app.webview_windows() {
        if !label.starts_with("print-") && !label.starts_with("html-output-") { continue; }
        let (tx, rx) = std::sync::mpsc::channel();
        window.on_window_event(move |event| { if matches!(event, tauri::WindowEvent::Destroyed) { let _ = tx.send(()); } });
        if app.get_webview_window(&label).is_none() { continue; }
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(600)))
            .await.map_err(|_| "인쇄 창 대기를 마치지 못했습니다.")?.map_err(|_| "인쇄 창이 아직 열려 있습니다. 출력 상태를 확인해 주세요.")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn office_executor_output(window: tauri::WebviewWindow, app: tauri::AppHandle, request_id: String, command: Value) -> Result<Value, String> {
    let state = app.state::<Outputs>();
    if window.label() != super::LABEL || !window.url().ok().is_some_and(|url| super::is_parent(&state.parent, &url)) {
        return Err("이 문서 실행기의 출력 요청이 아닙니다.".into());
    }
    if request_id.is_empty() || request_id.len() > 80 || !request_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("출력 요청 번호가 올바르지 않습니다.".into());
    }
    let parsed: Command = serde_json::from_value(command.clone()).map_err(|_| "연결되지 않은 문서 출력 요청입니다.")?;
    {
        let mut receipts = state.receipts.lock().map_err(|_| "출력 기록을 읽지 못했습니다.")?;
        if let Some(prior) = receipts.get(&request_id) {
            return match prior {
                Receipt::Done(input, result) if input == &command => result.clone(),
                Receipt::Pending(input) if input == &command => Err("출력이 진행 중입니다. 새 요청으로 다시 실행하지 않았습니다.".into()),
                _ => Err("같은 출력 번호로 다른 내용을 실행할 수 없습니다.".into()),
            };
        }
        // Receipts live only in this owned process; never evict a printing receipt
        // and accidentally allow a second OS print on an uncertain transport.
        let used: usize = receipts.values().map(|r| match r {
            Receipt::Pending(input) => input.to_string().len(),
            Receipt::Done(input, result) => input.to_string().len() + result.as_ref().map(|value| value.to_string().len()).unwrap_or_default(),
        }).sum();
        if receipts.len() >= 2048 || used + command.to_string().len() > 256_000_000 { return Err("한 요청의 문서 출력 한도를 넘었습니다.".into()); }
        receipts.insert(request_id.clone(), Receipt::Pending(command.clone()));
    }
    let result = match parsed {
        Command::SvgPdf { job } => crate::office_output::render_svg_pdf(job).await.and_then(bytes),
        Command::HtmlPdf { job } => crate::office_html_output::render_html_pdf(app.clone(), job).await.and_then(bytes),
        Command::SvgPrint { job } => match crate::office_output::print_svg(app.clone(), job).await {
            Ok(()) => wait_for_print_windows(&app).await.map(|_| Value::Null), Err(error) => Err(error),
        },
        Command::HtmlPrint { job } => match crate::office_html_output::print_html(app.clone(), job).await {
            Ok(()) => wait_for_print_windows(&app).await.map(|_| Value::Null), Err(error) => Err(error),
        },
        Command::Browser { command } => crate::office_browser::office_browser(window, app.clone(), command).await,
    };
    state.receipts.lock().map_err(|_| "출력 완료 기록을 보존하지 못했습니다.")?.insert(request_id, Receipt::Done(command, result.clone()));
    result
}

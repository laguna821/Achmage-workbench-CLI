//! The original Office renderers own pagination and print markup. Only the
//! Electron hidden-window operation is replaced here by the system WebView.
use std::{collections::HashMap, path::PathBuf, sync::{mpsc, Arc, Mutex}, time::Duration};
use serde::Deserialize;
use base64::Engine;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const MAX_BYTES: usize = 64 * 1024 * 1024;
const CSP: &str = "default-src 'none'; script-src 'none'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

fn trace(id: &str, event: &str) {
    #[cfg(debug_assertions)]
    if std::env::var_os("WORKBENCH_OUTPUT_TRACE_DIR").is_some() { eprintln!("Output {id}: {event}"); }
    #[cfg(not(debug_assertions))]
    let _ = (id, event);
}

#[derive(Clone, Deserialize)]
pub struct HtmlAsset { mime: String, base64: String }

#[derive(Clone, Deserialize)]
pub struct Margins { top: f64, right: f64, bottom: f64, left: f64 }
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlJob {
    html: String,
    #[serde(default)]
    assets: Vec<HtmlAsset>,
    width_in: f64,
    height_in: f64,
    margins: Margins,
    scale: f64,
}

impl HtmlJob {
    fn validate(&self) -> Result<(), String> {
        let numbers = [self.width_in, self.height_in, self.scale, self.margins.top,
            self.margins.right, self.margins.bottom, self.margins.left];
        let asset_bytes: usize = self.assets.iter().map(|asset| asset.base64.len()).sum();
        if self.assets.iter().any(|asset| tauri::http::HeaderValue::from_str(&asset.mime).is_err()) { return Err("출력 자산 형식이 올바르지 않습니다.".into()); }
        if self.html.is_empty() || self.html.len().saturating_add(asset_bytes) > MAX_BYTES || self.assets.len() > 512 || numbers.iter().any(|n| !n.is_finite())
            || !(0.1..=100.0).contains(&self.width_in) || !(0.1..=100.0).contains(&self.height_in)
            || !(0.1..=2.0).contains(&self.scale)
            || numbers[3..].iter().any(|n| *n < 0.0 || *n > 10.0)
            || self.margins.left + self.margins.right >= self.width_in
            || self.margins.top + self.margins.bottom >= self.height_in {
            return Err("인쇄 문서의 크기·용지·여백을 확인해 주세요.".into());
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct HtmlJobs(Mutex<HashMap<String, HtmlDocument>>);
struct HtmlDocument { html: String, assets: Vec<HtmlAsset>, ready: Completion }

pub fn serve(app: &tauri::AppHandle, path: &str, query: Option<&str>) -> tauri::http::Response<Vec<u8>> {
    let mut parts = path.trim_start_matches('/').split('/'); let first = parts.next().unwrap_or_default();
    let signal = first == "ready" || first == "error";
    let id = if signal { parts.next().unwrap_or_default() } else { first };
    let resource = if parts.next() == Some("asset") { parts.next().and_then(|value| value.parse::<usize>().ok()) } else { None };
    let body = app.state::<HtmlJobs>().0.lock().ok().and_then(|jobs| jobs.get(id).and_then(|document| {
        if signal {
            let message = url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()).find(|(key, _)| key == "message").map(|(_, value)| value.into_owned()).unwrap_or_default();
            trace(id, &format!("{first} {message}"));
            document.ready.finish(if first == "ready" { Ok(()) } else { Err(format!("출력할 문서를 불러오지 못했습니다: {message}")) });
            Some(("text/plain".into(), b"ok".to_vec()))
        } else if let Some(index) = resource {
            let asset = document.assets.get(index)?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(&asset.base64).ok()?;
            Some((asset.mime.clone(), bytes))
        } else { Some(("text/html; charset=utf-8".into(), document.html.as_bytes().to_vec())) }
    }));
    tauri::http::Response::builder().status(if body.is_some() { 200 } else { 404 })
        .header("Content-Type", body.as_ref().map(|(mime, _)| mime.as_str()).unwrap_or("text/plain"))
        .header("Cache-Control", "no-store").header("Content-Security-Policy", CSP)
        .header("Access-Control-Allow-Origin", "*").header("X-Content-Type-Options", "nosniff")
        .body(body.map(|(_, bytes)| bytes).unwrap_or_default()).unwrap()
}

#[derive(Clone)]
struct Completion(Arc<Mutex<Option<mpsc::SyncSender<Result<(), String>>>>>);
impl Completion {
    fn finish(&self, result: Result<(), String>) {
        if let Some(tx) = self.0.lock().unwrap().take() { let _ = tx.send(result); }
    }
}

/// Wait for the resources that affect pagination. The script is injected by
/// native code; the document's own scripts, navigation and network are blocked.
fn ready_script(id: &str) -> String {
    format!(r#"(async () => {{
      if (document.querySelector('meta[name="workbench-output-id"]')?.content !== '{id}') throw new Error('출력 문서를 불러오지 못했습니다.');
      await document.fonts.ready;
      // ProseMirror uses sourceless img separators around page breaks. They
      // are editing placeholders, not image resources that can be decoded.
      await Promise.all(Array.from(document.images)
        .filter(image => image.currentSrc || image.getAttribute('src')?.trim())
        .map(image => image.decode()));
      await Promise.all(Array.from(document.querySelectorAll('svg image'), element => {{
        const source = element.getAttribute('href') || element.getAttribute('xlink:href');
        if (!source) return;
        const image = new Image(); image.src = source; return image.decode();
      }}));
      document.documentElement.getBoundingClientRect();
      // Hidden WebKit windows may suspend requestAnimationFrame. The explicit
      // layout flush and task boundary work for both visible and hidden output.
      await new Promise(resolve => setTimeout(resolve, 0));
      await fetch('/ready/{id}', {{ cache: 'no-store' }});
    }})().catch(error => fetch('/error/{id}?message=' + encodeURIComponent(String(error)), {{ cache: 'no-store' }}));"#)
}

async fn output(app: tauri::AppHandle, mut job: HtmlJob, print: bool) -> Result<Vec<u8>, String> {
    job.validate()?;
    let mut random = [0_u8; 16]; getrandom::fill(&mut random).map_err(|e| e.to_string())?;
    let id = format!("html-output-{}", random.iter().map(|b| format!("{b:02x}")).collect::<String>());
    #[cfg(debug_assertions)]
    if let Some(root) = std::env::var_os("WORKBENCH_OUTPUT_TRACE_DIR") {
        let root = PathBuf::from(root);
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        std::fs::write(root.join(format!("{id}.html")), &job.html).map_err(|e| e.to_string())?;
        eprintln!("Output trace: {id}, {} × {} in, scale {}", job.width_in, job.height_in, job.scale);
    }
    let temp = tempfile::Builder::new().prefix("workbench-output-").tempdir().map_err(|e| e.to_string())?;
    let path = temp.path().join("document.pdf");
    let (tx, rx) = mpsc::sync_channel(1);
    let completion = Completion(Arc::new(Mutex::new(Some(tx))));
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let readiness = Completion(Arc::new(Mutex::new(Some(ready_tx))));
    {
        let state = app.state::<HtmlJobs>(); let mut jobs = state.0.lock().map_err(|e| e.to_string())?;
        if jobs.len() >= 4 { return Err("다른 문서의 출력이 끝난 뒤 다시 실행해 주세요.".into()); }
        let mut html = std::mem::take(&mut job.html);
        let marker = format!(r#"<meta name="workbench-output-id" content="{id}">"#);
        if let Some(at) = html.find("</head>") { html.insert_str(at, &marker); } else { html.push_str(&marker); }
        for index in 0..job.assets.len() { html = html.replace(&format!("workbench-print-asset:{index}:"), &format!("/{id}/asset/{index}")); }
        jobs.insert(id.clone(), HtmlDocument { html, assets: std::mem::take(&mut job.assets), ready: readiness.clone() });
    }
    let load_url: tauri::Url = format!("workbench-output://localhost/{id}").parse().unwrap();
    let load_path = format!("/{id}");
    let ready = ready_script(&id); let load_completion = readiness.clone(); let load_id = id.clone();
    let destroyed = completion.clone(); let cleanup_app = app.clone(); let cleanup_id = id.clone();
    let builder = WebviewWindowBuilder::new(&app, &id, WebviewUrl::External(load_url.clone()))
        .title("문서 출력 · Achmage Workbench").inner_size(900.0, 900.0).visible(print)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |url| {
            let own_protocol = url.scheme() == "workbench-output" || (url.scheme() == "http" && url.host_str() == Some("workbench-output.localhost"));
            own_protocol && url.path() == load_path
        })
        .on_page_load(move |view, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                trace(&load_id, "load finished");
                if let Err(error) = view.eval(&ready) { load_completion.finish(Err(error.to_string())); }
            }
        });
    // This directory already belongs to the disposable CLI profile. Reuse its
    // WebContext: on Linux, incognito creates a new context while Tauri caches
    // protocol registration by data_directory, breaking the next print chunk.
    let builder = if let Some(root) = crate::office_cli::data_dir(&app) { builder.data_directory(root.join("output-webview")) } else { builder };
    let view = builder.build();
    let result = match view {
        Err(error) => Err(error.to_string()),
        Ok(view) => {
            view.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    cleanup_app.state::<HtmlJobs>().0.lock().unwrap().remove(&cleanup_id);
                    readiness.finish(Err("인쇄 창이 닫혔습니다.".into()));
                    destroyed.finish(Err("인쇄 창이 닫혔습니다.".into()));
                }
            });
            let ready = tauri::async_runtime::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(120))
                .map_err(|_| "출력 문서 준비 시간이 지났습니다.".to_string())?)
                .await.map_err(|e| e.to_string()).and_then(|r| r);
            if let Err(error) = ready { completion.finish(Err(error)); }
            else {
                trace(&id, "print started");
                // Printing starts after readiness, without navigating away from
                // the document or re-entering a WebView load callback.
                let done = completion.clone();
                if let Err(error) = view.with_webview(move |webview| platform_output(webview, job, path, print, done)) {
                    completion.finish(Err(error.to_string()));
                }
            }
            let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(if print { 600 } else { 120 }))
                .map_err(|_| "출력 응답 시간이 지났습니다. 문서를 확인한 뒤 다시 실행해 주세요.".to_string())?)
                .await.map_err(|e| e.to_string()).and_then(|r| r);
            trace(&id, &format!("completed {result:?}"));
            // WebView2's ShowPrintUI returns while the system UI is open. Keep
            // its preview alive until the user closes it; PDF exports are hidden.
            if !cfg!(target_os = "windows") || !print || result.is_err() { let _ = view.destroy(); }
            result
        }
    };
    if !cfg!(target_os = "windows") || !print || result.is_err() { app.state::<HtmlJobs>().0.lock().unwrap().remove(&id); }
    result?;
    if print { return Ok(vec![]); }
    let path = temp.path().join("document.pdf");
    if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > MAX_BYTES as u64 { return Err("출력 PDF가 너무 큽니다.".into()); }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"%PDF-") { return Err("시스템 인쇄기가 올바른 PDF를 반환하지 않았습니다.".into()); }
    Ok(bytes)
}

#[tauri::command]
pub async fn render_html_pdf(app: tauri::AppHandle, job: HtmlJob) -> Result<tauri::ipc::Response, String> {
    Ok(tauri::ipc::Response::new(output(app, job, false).await?))
}

#[tauri::command]
pub async fn print_html(app: tauri::AppHandle, job: HtmlJob) -> Result<(), String> {
    output(app, job, true).await.map(|_| ())
}

#[cfg(target_os = "linux")]
fn platform_output(webview: tauri::webview::PlatformWebview, job: HtmlJob, path: PathBuf, print: bool, done: Completion) {
    use webkit2gtk::{PrintOperationExt, SettingsExt, WebViewExt};
    let view = webview.inner();
    if let Some(settings) = view.settings() { settings.set_print_backgrounds(true); }
    let operation = webkit2gtk::PrintOperation::new(&view);
    let setup = gtk::PageSetup::new();
    let paper = gtk::PaperSize::new_custom("workbench", "Document", job.width_in, job.height_in, gtk::Unit::Inch);
    setup.set_paper_size(&paper);
    setup.set_top_margin(job.margins.top, gtk::Unit::Inch); setup.set_right_margin(job.margins.right, gtk::Unit::Inch);
    setup.set_bottom_margin(job.margins.bottom, gtk::Unit::Inch); setup.set_left_margin(job.margins.left, gtk::Unit::Inch);
    operation.set_page_setup(&setup);
    let settings = gtk::PrintSettings::new(); settings.set_scale(job.scale * 100.0); settings.set_use_color(true);
    if !print {
        settings.set_printer("Print to File"); settings.set("output-file-format", Some("pdf"));
        settings.set("output-uri", Some(url::Url::from_file_path(path).unwrap().as_str()));
    }
    operation.set_print_settings(&settings);
    let failure = done.clone(); operation.connect_failed(move |_, error| failure.finish(Err(error.to_string())));
    let finished = done.clone(); operation.connect_finished(move |_| finished.finish(Ok(())));
    if print {
        if operation.run_dialog(None::<&gtk::Window>) == webkit2gtk::PrintOperationResponse::Cancel { done.finish(Ok(())); }
    } else { operation.print(); }
}

#[cfg(target_os = "windows")]
fn platform_output(webview: tauri::webview::PlatformWebview, job: HtmlJob, path: PathBuf, print: bool, done: Completion) {
    use windows::core::{HSTRING, Interface, PCWSTR};
    use webview2_com::{PrintToPdfCompletedHandler, Microsoft::Web::WebView2::Win32::*};
    let result = (|| -> windows::core::Result<()> { unsafe {
        let view = webview.controller().CoreWebView2()?;
        if print {
            view.cast::<ICoreWebView2_16>()?.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)?;
            done.finish(Ok(())); return Ok(());
        }
        let settings = webview.environment().cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
        settings.SetPageWidth(job.width_in)?; settings.SetPageHeight(job.height_in)?;
        settings.SetMarginTop(job.margins.top)?; settings.SetMarginRight(job.margins.right)?;
        settings.SetMarginBottom(job.margins.bottom)?; settings.SetMarginLeft(job.margins.left)?;
        settings.SetScaleFactor(job.scale)?; settings.SetShouldPrintBackgrounds(true)?; settings.SetShouldPrintHeaderAndFooter(false)?;
        let finished = done.clone(); let path = HSTRING::from(path.as_os_str());
        view.cast::<ICoreWebView2_7>()?.PrintToPdf(PCWSTR(path.as_ptr()), &settings,
            &PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                finished.finish(status.map_err(|e| e.to_string()).and_then(|_| if success { Ok(()) } else { Err("시스템 PDF 출력을 완료하지 못했습니다.".into()) })); Ok(())
            })))
    }})();
    if let Err(error) = result { done.finish(Err(error.to_string())); }
}

#[cfg(target_os = "macos")]
fn platform_output(webview: tauri::webview::PlatformWebview, job: HtmlJob, path: PathBuf, print: bool, done: Completion) {
    use objc2::{AnyThread, runtime::{AnyObject, ProtocolObject}};
    use objc2_app_kit::{NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob};
    use objc2_foundation::{NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;
    unsafe {
        let view = &*(webview.inner() as *const WKWebView);
        let info = NSPrintInfo::init(NSPrintInfo::alloc());
        info.setPaperSize(NSSize::new(job.width_in * 72.0, job.height_in * 72.0));
        info.setTopMargin(job.margins.top * 72.0); info.setRightMargin(job.margins.right * 72.0);
        info.setBottomMargin(job.margins.bottom * 72.0); info.setLeftMargin(job.margins.left * 72.0);
        info.setScalingFactor(job.scale); info.setHorizontallyCentered(false); info.setVerticallyCentered(false);
        if !print {
            info.setJobDisposition(NSPrintSaveJob);
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
            info.dictionary().setObject_forKey(&*(&*url as *const NSURL as *const AnyObject), ProtocolObject::from_ref(NSPrintJobSavingURL));
        }
        let operation = view.printOperationWithPrintInfo(&info);
        operation.setShowsPrintPanel(print); operation.setShowsProgressPanel(false);
        let ok = operation.runOperation();
        done.finish(if ok || print { Ok(()) } else { Err("시스템 PDF 출력을 완료하지 못했습니다.".into()) });
    }
}

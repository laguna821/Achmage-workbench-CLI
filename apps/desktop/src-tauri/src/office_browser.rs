//! BrowserDriver operations for IeumOffice's unchanged HTML-to-DOCX converter.
//! Document windows have no app capability; only their creating parent drives them.
use std::{collections::HashMap, sync::{mpsc, Arc, Mutex}, time::Duration};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow, WebviewWindowBuilder, WebviewUrl};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport { width: f64, height: f64, device_scale_factor: f64 }
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip { x: f64, y: f64, width: f64, height: f64, page_x: f64, page_y: f64 }
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum BrowserCommand {
    Create { html: String, viewport: Viewport, scripts: Vec<String> },
    Evaluate { id: String, expression: String },
    Viewport { id: String, viewport: Viewport },
    Snapshot { id: String, clip: Clip, transparent: bool },
    Close { id: String },
}
struct BrowserJob {
    owner: String,
    html: String,
    viewport: Mutex<Viewport>,
    // Unique persistent context, inside an owned temporary directory. Combining
    // repeated incognito views with one context key loses Linux URI handlers.
    _profile: tempfile::TempDir,
    _expiry: mpsc::Sender<()>,
}
#[derive(Default)]
pub struct BrowserJobs(Mutex<HashMap<String, Arc<BrowserJob>>>);

fn trace(message: impl std::fmt::Display) {
    if std::env::var_os("WORKBENCH_BROWSER_TRACE").is_some() { eprintln!("[office-browser] {message}"); }
}

pub fn serve(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let html = app.state::<BrowserJobs>().0.lock().ok()
        .and_then(|jobs| jobs.get(path.trim_start_matches('/')).map(|job| job.html.clone()));
    tauri::http::Response::builder().status(if html.is_some() { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store")
        // Keep document scripts and relative assets, but deny app-origin storage,
        // modal dialogs, popups and access to another document's browsing context.
        .header("Content-Security-Policy", "sandbox allow-scripts allow-forms; frame-ancestors 'none'")
        .header("Referrer-Policy", "no-referrer").header("X-Content-Type-Options", "nosniff")
        .body(html.unwrap_or_default().into_bytes()).unwrap()
}

fn validate_viewport(v: Viewport) -> Result<(), String> {
    if ![v.width, v.height, v.device_scale_factor].iter().all(|n| n.is_finite())
        || !(16.0..=4096.0).contains(&v.width) || !(16.0..=8192.0).contains(&v.height)
        || !(0.5..=3.0).contains(&v.device_scale_factor)
        || v.width * v.height * v.device_scale_factor.powi(2) > 32_000_000.0 {
        return Err("문서 변환 화면의 크기를 확인해 주세요.".into());
    }
    Ok(())
}

async fn wait<T: Send + 'static>(rx: mpsc::Receiver<Result<T, String>>) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(35))
        .map_err(|_| "문서 변환 화면이 응답하지 않습니다.".to_string())?)
        .await.map_err(|e| e.to_string())?
}

async fn resize(view: &WebviewWindow, viewport: Viewport) -> Result<(), String> {
    validate_viewport(viewport)?;
    #[cfg(not(target_os = "windows"))]
    {
        view.set_size(tauri::LogicalSize::new(viewport.width * viewport.device_scale_factor, viewport.height * viewport.device_scale_factor)).map_err(|e| e.to_string())?;
        view.set_zoom(viewport.device_scale_factor).map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;
        // An unmapped GTK parent does not allocate its child. Giving the actual
        // WebView its bounds preserves layout without showing an export window.
        let (tx, rx) = mpsc::channel();
        view.with_webview(move |platform| {
            let width = (viewport.width * viewport.device_scale_factor).round() as i32;
            let height = (viewport.height * viewport.device_scale_factor).round() as i32;
            let widget = platform.inner();
            widget.set_size_request(width, height);
            widget.size_allocate(&gtk::Allocation::new(0, 0, width, height));
            let _ = tx.send(Ok(()));
        }).map_err(|e| e.to_string())?;
        wait(rx).await?;
    }
    #[cfg(target_os = "windows")]
    {
        view.set_size(tauri::LogicalSize::new(viewport.width, viewport.height)).map_err(|e| e.to_string())?;
        cdp(view, "Emulation.setDeviceMetricsOverride", json!({"width":viewport.width as u32,"height":viewport.height as u32,"deviceScaleFactor":viewport.device_scale_factor,"mobile":false})).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn office_browser(window: WebviewWindow, app: tauri::AppHandle, command: BrowserCommand) -> Result<Value, String> {
    if let BrowserCommand::Create { html, viewport, scripts } = command {
        validate_viewport(viewport)?;
        if html.len() > 8 * 1024 * 1024 || scripts.len() > 8 || scripts.iter().map(String::len).sum::<usize>() > 128 * 1024 {
            return Err("변환할 HTML이 너무 큽니다.".into());
        }
        let mut random = [0_u8; 16]; getrandom::fill(&mut random).map_err(|e| e.to_string())?;
        let id = format!("office-browser-{}", random.iter().map(|n| format!("{n:02x}")).collect::<String>());
        let mut temporary = tempfile::Builder::new(); temporary.prefix("workbench-html-");
        let profile = if let Some(root) = crate::office_cli::data_dir(&app) { temporary.tempdir_in(root) } else { temporary.tempdir() }.map_err(|e| e.to_string())?;
        let data_dir = profile.path().to_path_buf();
        let (expiry, expires) = mpsc::channel();
        {
            let state = app.state::<BrowserJobs>(); let mut jobs = state.0.lock().map_err(|e| e.to_string())?;
            if jobs.len() >= 4 { return Err("다른 문서의 변환이 끝난 뒤 다시 실행해 주세요.".into()); }
            jobs.insert(id.clone(), Arc::new(BrowserJob { owner: window.label().into(), html, viewport: Mutex::new(viewport), _profile: profile, _expiry: expiry }));
        }
        let (tx, rx) = mpsc::sync_channel(1); let loaded = Arc::new(Mutex::new(Some(tx)));
        let load_path = format!("/{id}"); let ready = loaded.clone();
        let mut builder = WebviewWindowBuilder::new(&app, &id, WebviewUrl::External("about:blank".parse().unwrap()))
            .title("문서 변환 · Achmage Workbench").visible(false).skip_taskbar(true)
            .transparent(true).data_directory(data_dir)
            .inner_size(viewport.width * viewport.device_scale_factor, viewport.height * viewport.device_scale_factor)
            .on_navigation(move |url| {
                url.as_str() == "about:blank" || ((url.scheme() == "workbench-browser" || (url.scheme() == "http" && url.host_str() == Some("workbench-browser.localhost"))) && url.path() == load_path)
            })
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_page_load(move |_, payload| {
                if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) && payload.url().as_str() != "about:blank" {
                    if let Some(tx) = ready.lock().unwrap().take() { let _ = tx.send(Ok(())); }
                }
            });
        for script in scripts { builder = builder.initialization_script(&script); }
        let view = match builder.build() {
            Ok(view) => view,
            Err(error) => { app.state::<BrowserJobs>().0.lock().unwrap().remove(&id); return Err(error.to_string()); }
        };
        let cleanup_app = app.clone(); let cleanup_id = id.clone();
        view.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) { cleanup_app.state::<BrowserJobs>().0.lock().unwrap().remove(&cleanup_id); }
        });
        let watchdog = app.clone(); let timeout_id = id.clone();
        std::thread::spawn(move || {
            if matches!(expires.recv_timeout(Duration::from_secs(180)), Err(mpsc::RecvTimeoutError::Timeout)) {
                if let Some(view) = watchdog.get_webview_window(&timeout_id) { let _ = view.destroy(); }
            }
        });
        // Apply the viewport before authored scripts run, as the original
        // driver does. Responsive charts must not observe a zero-sized page.
        if let Err(error) = resize(&view, viewport).await { let _ = view.destroy(); return Err(error); }
        if let Err(error) = view.navigate(format!("workbench-browser://localhost/{id}").parse().unwrap()) { let _ = view.destroy(); return Err(error.to_string()); }
        if let Err(error) = wait(rx).await { let _ = view.destroy(); return Err(error); }
        if std::env::var_os("WORKBENCH_BROWSER_TRACE").is_some() {
            trace(format!("created {id}: {:?}", evaluate(&view, "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,text:document.body.innerText})".into()).await));
        }
        return Ok(json!({"id":id}));
    }
    let id = match &command {
        BrowserCommand::Evaluate { id, .. } | BrowserCommand::Viewport { id, .. } | BrowserCommand::Snapshot { id, .. } | BrowserCommand::Close { id } => id,
        BrowserCommand::Create { .. } => unreachable!(),
    };
    let job = app.state::<BrowserJobs>().0.lock().map_err(|e| e.to_string())?.get(id).cloned().ok_or("문서 변환 창이 닫혔습니다.")?;
    if job.owner != window.label() { return Err("이 문서 변환 창의 요청이 아닙니다.".into()); }
    let view = app.get_webview_window(id).ok_or("문서 변환 창이 닫혔습니다.")?;
    let trace_id = id.clone();
    match command {
        BrowserCommand::Evaluate { expression, .. } => {
            if expression.len() > 4 * 1024 * 1024 { return Err("문서 변환 요청이 너무 큽니다.".into()); }
            let value = evaluate(&view, expression).await;
            trace(format!("evaluate {trace_id}: {}", format!("{value:?}").chars().take(1600).collect::<String>()));
            Ok(json!({"value":value?}))
        }
        BrowserCommand::Viewport { viewport, .. } => {
            resize(&view, viewport).await?; *job.viewport.lock().unwrap() = viewport; Ok(Value::Null)
        }
        BrowserCommand::Snapshot { clip, transparent, .. } => {
            let v = *job.viewport.lock().unwrap();
            if ![clip.x,clip.y,clip.width,clip.height,clip.page_x,clip.page_y].iter().all(|n| n.is_finite() && *n >= 0.0)
                || clip.width < 1.0 || clip.height < 1.0 || clip.x + clip.width > v.width + 1.0 || clip.y + clip.height > v.height + 1.0 {
                return Err("캡처할 영역이 문서 변환 화면 밖에 있습니다.".into());
            }
            let result = snapshot(&view, clip, v.device_scale_factor, transparent).await;
            trace(format!("snapshot {trace_id} {}x{} at {},{}: {:?}", clip.width, clip.height, clip.x, clip.y, result.as_ref().map(Vec::len)));
            let bytes = result?;
            if bytes.len() > 64 * 1024 * 1024 { return Err("문서의 그림이 너무 큽니다.".into()); }
            Ok(json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes)}))
        }
        BrowserCommand::Close { .. } => { view.destroy().map_err(|e| e.to_string())?; Ok(Value::Null) }
        BrowserCommand::Create { .. } => unreachable!(),
    }
}

#[cfg(target_os = "linux")]
async fn evaluate(view: &WebviewWindow, expression: String) -> Result<Value, String> {
    use webkit2gtk::WebViewExt;
    let (tx, rx) = mpsc::channel();
    view.with_webview(move |platform| {
        platform.inner().call_async_javascript_function(&format!("return JSON.stringify({{value: await ({expression})}});"), None, None, None, None::<&webkit2gtk::gio::Cancellable>, move |result| {
            let result = result.map_err(|e| e.to_string()).and_then(|value| serde_json::from_str::<Value>(&value.to_string()).map_err(|e| e.to_string())).map(|value| value.get("value").cloned().unwrap_or(Value::Null));
            let _ = tx.send(result);
        });
    }).map_err(|e| e.to_string())?;
    wait(rx).await
}

#[cfg(target_os = "linux")]
async fn snapshot(view: &WebviewWindow, clip: Clip, scale: f64, transparent: bool) -> Result<Vec<u8>, String> {
    use webkit2gtk::WebViewExt;
    let (tx, rx) = mpsc::channel();
    view.with_webview(move |platform| {
        platform.inner().snapshot(webkit2gtk::SnapshotRegion::Visible, if transparent { webkit2gtk::SnapshotOptions::TRANSPARENT_BACKGROUND } else { webkit2gtk::SnapshotOptions::empty() }, None::<&webkit2gtk::gio::Cancellable>, move |result| {
            let result = (|| {
                let source = result.map_err(|e| e.to_string())?;
                let image = gtk::cairo::ImageSurface::create(gtk::cairo::Format::ARgb32, (clip.width * scale).round() as i32, (clip.height * scale).round() as i32).map_err(|e| e.to_string())?;
                let canvas = gtk::cairo::Context::new(&image).map_err(|e| e.to_string())?;
                canvas.set_source_surface(&source, -clip.x * scale, -clip.y * scale).map_err(|e| e.to_string())?;
                canvas.paint().map_err(|e| e.to_string())?;
                let mut png = Vec::new(); image.write_to_png(&mut png).map_err(|e| e.to_string())?; Ok(png)
            })(); let _ = tx.send(result);
        });
    }).map_err(|e| e.to_string())?;
    wait(rx).await
}

#[cfg(target_os = "windows")]
async fn cdp(view: &WebviewWindow, method: &str, params: Value) -> Result<Value, String> {
    use windows::core::HSTRING;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    let (tx, rx) = mpsc::channel(); let method = method.to_owned();
    view.with_webview(move |platform| { unsafe {
        let failed = tx.clone();
        let result = platform.controller().CoreWebView2().and_then(|webview| webview.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params.to_string()),
            &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result| {
                let value = status.map_err(|e| e.to_string()).and_then(|_| serde_json::from_str(&result).map_err(|e| e.to_string()));
                let _ = tx.send(value); Ok(())
            }))));
        if let Err(error) = result { let _ = failed.send(Err(error.to_string())); }
    }}).map_err(|e| e.to_string())?;
    wait(rx).await
}

#[cfg(target_os = "windows")]
async fn evaluate(view: &WebviewWindow, expression: String) -> Result<Value, String> {
    let reply = cdp(view, "Runtime.evaluate", json!({"expression":format!("(async()=>({{value:await ({expression})}}))()"),"awaitPromise":true,"returnByValue":true})).await?;
    if let Some(error) = reply.get("exceptionDetails") { return Err(error.to_string()); }
    Ok(reply.pointer("/result/value/value").cloned().unwrap_or(Value::Null))
}

#[cfg(target_os = "windows")]
async fn snapshot(view: &WebviewWindow, clip: Clip, _scale: f64, transparent: bool) -> Result<Vec<u8>, String> {
    if transparent { cdp(view, "Emulation.setDefaultBackgroundColorOverride", json!({"color":{"r":0,"g":0,"b":0,"a":0}})).await?; }
    let result = cdp(view, "Page.captureScreenshot", json!({"format":"png","captureBeyondViewport":true,"clip":{"x":clip.page_x,"y":clip.page_y,"width":clip.width,"height":clip.height,"scale":1}})).await;
    if transparent { let _ = cdp(view, "Emulation.setDefaultBackgroundColorOverride", json!({})).await; }
    let reply = result?;
    base64::engine::general_purpose::STANDARD.decode(reply.get("data").and_then(Value::as_str).ok_or("그림 캡처를 받지 못했습니다.")?).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
async fn evaluate(view: &WebviewWindow, expression: String) -> Result<Value, String> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::{WKContentWorld, WKWebView};
    let (tx, rx) = mpsc::channel();
    view.with_webview(move |platform| { unsafe {
        let webview = &*(platform.inner() as *const WKWebView);
        let done = block2::RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            let result = if !error.is_null() { Err((&*error).localizedDescription().to_string()) }
                else if value.is_null() { Err("문서 변환 응답이 비어 있습니다.".into()) }
                else { serde_json::from_str::<Value>(&(&*(value as *mut NSString)).to_string()).map_err(|e| e.to_string()).map(|v| v.get("value").cloned().unwrap_or(Value::Null)) };
            let _ = tx.send(result);
        });
        webview.callAsyncJavaScript_arguments_inFrame_inContentWorld_completionHandler(&NSString::from_str(&format!("return JSON.stringify({{value:await ({expression})}});")), None, None, &WKContentWorld::pageWorld(), Some(&done));
    }}).map_err(|e| e.to_string())?;
    wait(rx).await
}

#[cfg(target_os = "macos")]
async fn snapshot(view: &WebviewWindow, clip: Clip, scale: f64, _transparent: bool) -> Result<Vec<u8>, String> {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    let (tx, rx) = mpsc::channel();
    view.with_webview(move |platform| { unsafe {
        let webview = &*(platform.inner() as *const WKWebView);
        let config = WKSnapshotConfiguration::new(MainThreadMarker::new().unwrap());
        config.setRect(NSRect::new(NSPoint::new(clip.x * scale, clip.y * scale), NSSize::new(clip.width * scale, clip.height * scale)));
        config.setAfterScreenUpdates(true);
        let done = block2::RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let result = (|| {
                if !error.is_null() { return Err((&*error).localizedDescription().to_string()); }
                if image.is_null() { return Err("문서 그림을 받지 못했습니다.".into()); }
                let tiff = (&*image).TIFFRepresentation().ok_or("문서 그림을 읽지 못했습니다.")?;
                let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff).ok_or("문서 그림을 해독하지 못했습니다.")?;
                let png = bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()).ok_or("문서 그림을 변환하지 못했습니다.")?;
                Ok(png.to_vec())
            })(); let _ = tx.send(result);
        });
        webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &done);
    }}).map_err(|e| e.to_string())?;
    wait(rx).await
}

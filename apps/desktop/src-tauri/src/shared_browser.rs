//! Visible web pages use separate, unprivileged native child webviews. The Office converter stays isolated.
use std::{collections::{HashMap, HashSet}, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Manager, Webview, WebviewUrl, LogicalPosition, LogicalSize};
use tauri::webview::{WebviewBuilder, NewWindowResponse, PageLoadEvent, PermissionResponse};
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
use tauri::webview::DownloadEvent;

#[path = "browser_driver/mod.rs"]
mod platform;

const SCRIPT: &str = include_str!("shared_browser.js");
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Control { generation: u64, owner: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    page_id: String, profile_id: String, navigation_revision: u64, capabilities: Vec<String>,
    url: String, title: String, loading: bool, control: Control, popups: Vec<Value>, error: Option<String>,
    interaction_at: u64,
    download_directory: Option<String>, downloads: Vec<Value>, permissions: Vec<Value>, permission_support: Vec<String>,
    site_permissions: Vec<Value>,
    #[serde(skip)] permission_store: Arc<platform::permissions::Store>,
    #[serde(skip)] visible: bool,
}
#[derive(Default)]
pub struct SharedBrowser {
    pages: Arc<Mutex<HashMap<String, Page>>>,
    receipts: Mutex<HashMap<String, Value>>,
    running: Mutex<HashSet<String>>,
    queues: Mutex<HashMap<String, Arc<tauri::async_runtime::Mutex<()>>>>,
    permission_store: Mutex<Option<Arc<platform::permissions::Store>>>,
}
fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn identifier(value: &str) -> bool { !value.is_empty() && value.len() <= 160 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }
fn label(id: &str) -> String { format!("wb-page-{id}") }
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> { value[key].as_str().ok_or_else(|| format!("잘못된 브라우저 입력: {key}")) }
fn allowed_url(app: &tauri::AppHandle, raw: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(raw).map_err(|_| "웹 주소를 확인해 주세요.")?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() || raw.len() > 8192 { return Err("http 또는 https 웹 주소만 열 수 있습니다.".into()); }
    if let Some(ready) = app.try_state::<crate::Ready>() {
        if let Ok(origin) = url::Url::parse(&ready.url) { if origin.origin() == url.origin() { return Err("앱 내부 주소는 일반 웹 탭에서 열 수 없습니다.".into()); } }
    }
    Ok(url)
}
async fn evaluate(view: Webview, expression: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        view.eval_with_callback(expression, move |value| { let _ = tx.send(value); }).map_err(|e| e.to_string())?;
        let raw = rx.recv_timeout(Duration::from_secs(12)).map_err(|_| "웹 페이지 응답을 확인하지 못했습니다. 자동 재실행하지 않습니다.".to_string())?;
        let value: Value = serde_json::from_str(&raw).map_err(|_| "웹 페이지 응답을 읽지 못했습니다.".to_string())?;
        if value.is_null() { return Err("페이지가 이동 중이거나 읽을 수 없는 페이지입니다.".into()); }
        Ok(value)
    }).await.map_err(|e| e.to_string())?
}
fn api_expression(expression: &str) -> String {
    format!("(()=>{{try{{const api=window.__ACHMAGE_PAGE__;if(!api)return {{error:'PAGE_NOT_READY'}};return {expression};}}catch(error){{return {{error:String(error.message||error)}};}}}})()")
}
fn current(app: &tauri::AppHandle, id: &str) -> Result<Page, String> {
    app.state::<SharedBrowser>().pages.lock().unwrap().get(id).cloned().ok_or_else(|| "웹 페이지가 닫혔습니다.".into())
}
fn update_control(app: &tauri::AppHandle, id: &str, value: &Value) {
    if let Ok(control) = serde_json::from_value::<Control>(value["control"].clone()) {
        if let Some(page) = app.state::<SharedBrowser>().pages.lock().unwrap().get_mut(id) {
            if control.generation >= page.control.generation { page.control = control; }
            if let Some(at) = value["interactionAt"].as_u64() { page.interaction_at = page.interaction_at.max(at); }
        }
    }
}
async fn create(app: &tauri::AppHandle, caller: &Webview, command: &Value) -> Result<Value, String> {
    let id = field(command, "pageId")?.to_string(); let profile = field(command, "profileId")?.to_string();
    if !identifier(&id) || !identifier(&profile) || id.len() > 80 || profile.len() > 80 { return Err("웹 탭 식별자가 올바르지 않습니다.".into()); }
    let url = allowed_url(app, field(command, "url")?)?;
    if let Ok(page) = current(app, &id) {
        if page.profile_id != profile { return Err("다른 프로필의 웹 탭입니다.".into()); }
        if app.get_webview(&label(&id)).is_some() { return Ok(json!(page)); }
        return Err("기존 페이지가 닫혔습니다. 새 탭으로 열어 주세요.".into());
    }
    let control: Control = serde_json::from_value(command["control"].clone()).map_err(|_| "제어권 정보가 올바르지 않습니다.")?;
    let pages = app.state::<SharedBrowser>().pages.clone();
    if pages.lock().unwrap().len() >= 64 { return Err("열린 웹 탭을 닫은 뒤 다시 열어 주세요.".into()); }
    let mut capabilities: Vec<String> = ["observe", "navigate", "dom_actions", "downloads", "permission_prompt"].iter().map(|s| s.to_string()).collect();
    #[cfg(not(target_os = "macos"))]
    capabilities.push("persistent_profile".into());
    #[cfg(target_os = "linux")]
    { capabilities.push("permission_decision".into()); capabilities.push("download_cancel".into()); }
    #[cfg(target_os = "macos")]
    let mac_store = platform::persistent_mac_profile(app, &profile)?;
    #[cfg(target_os = "macos")]
    if mac_store.is_some() { capabilities.push("persistent_profile".into()); }
    let permission_store = {
        let state = app.state::<SharedBrowser>(); let mut store = state.permission_store.lock().unwrap();
        if store.is_none() { *store = Some(Arc::new(platform::permissions::Store::load(app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("browser-profiles").join("site-permissions.json"))?)); }
        store.as_ref().unwrap().clone()
    };
    let page = Page { page_id: id.clone(), profile_id: profile.clone(), navigation_revision: 0, capabilities, url: url.to_string(), title: url.to_string(), loading: true, control, popups: Vec::new(), error: None, interaction_at: 0, visible: false,
        download_directory: None, downloads: Vec::new(), permissions: Vec::new(), permission_support: platform::permission_support(), site_permissions: permission_store.list(&profile), permission_store };
    pages.lock().unwrap().insert(id.clone(), page);
    let nav_pages = pages.clone(); let nav_id = id.clone(); let nav_app = app.clone();
    let load_pages = pages.clone(); let load_id = id.clone();
    let title_pages = pages.clone(); let title_id = id.clone();
    let popup_pages = pages.clone(); let popup_id = id.clone(); let popup_app = app.clone();
    let permission_pages = pages.clone(); let permission_id = id.clone();
    let mut builder = WebviewBuilder::new(label(&id), WebviewUrl::External(url))
        .initialization_script(SCRIPT)
        .disable_drag_drop_handler()
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |url| {
            if allowed_url(&nav_app, url.as_str()).is_err() { return false; }
            platform::invalidate(&nav_id);
            if let Some(page) = nav_pages.lock().unwrap().get_mut(&nav_id) { page.navigation_revision += 1; page.url = url.to_string(); page.loading = true; page.error = None; }
            true
        })
        .on_page_load(move |_, event| {
            if let Some(page) = load_pages.lock().unwrap().get_mut(&load_id) { page.loading = matches!(event.event(), PageLoadEvent::Started); page.url = event.url().to_string(); }
        })
        .on_document_title_changed(move |_, title| { if let Some(page) = title_pages.lock().unwrap().get_mut(&title_id) { page.title = title.chars().take(300).collect(); } })
        .on_new_window(move |url, _| {
            if allowed_url(&popup_app, url.as_str()).is_ok() {
                if let Some(page) = popup_pages.lock().unwrap().get_mut(&popup_id) {
                    if page.popups.len() >= 20 { page.popups.remove(0); }
                    page.popups.push(json!({"id":format!("{}-{}", now(), page.popups.len()), "url":url.as_str()}));
                }
            }
            NewWindowResponse::Deny
        })
        .on_permission_request(move |_, kind| {
            #[cfg(target_os = "linux")]
            { let _ = (&permission_pages, &permission_id, kind); PermissionResponse::Default }
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            { let _ = (&permission_pages, &permission_id, kind); PermissionResponse::Deny }
            #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
            {
                let kind = kind.to_string(); let supported = platform::permission_support().contains(&kind);
                if let Some(page) = permission_pages.lock().unwrap().get_mut(&permission_id) {
                    if page.permissions.len() >= 80 { page.permissions.remove(0); }
                    page.permissions.push(json!({"id":platform::new_id(),"kind":kind,"pageUrl":page.url,"navigationRevision":page.navigation_revision,"requestingOrigin":null,"requestedAt":now(),"expiresAt":now()+60000,"status":if supported {"native-prompt"} else {"unsupported"}}));
                }
                if supported { PermissionResponse::Default } else { PermissionResponse::Deny }
            }
        });
    // Wry's GTK download callbacks are context-wide. The GTK adapter instead matches Download.web_view.
    // WK's original navigation policy must still know a download delegate exists; the native
    // proxy takes ownership of the real WKDownload before this fallback callback can run.
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    { let download_pages = pages.clone(); let download_id = id.clone();
      builder = builder.on_download(move |_, event| {
            match event {
                DownloadEvent::Requested { url, destination } => platform::requested(&download_pages, &download_id, url.as_str(), destination),
                DownloadEvent::Finished { url, path, success } => { platform::finished(&download_pages, &download_id, url.as_str(), path.as_deref(), success); true },
                _ => false,
            }
        });
    }
    #[cfg(target_os = "macos")]
    { builder = if let Some(store) = mac_store { builder.data_store_identifier(store) } else { builder.incognito(true) }; }
    #[cfg(not(target_os = "macos"))]
    {
        let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("browser-profiles").join(&profile);
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        builder = builder.data_directory(path);
    }
    let result = caller.window().add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0));
    match result {
        Ok(view) => {
            if let Err(error) = platform::attach(&view, pages.clone(), id.clone()) { let _ = view.close(); pages.lock().unwrap().remove(&id); return Err(error); }
            view.hide().map_err(|e| e.to_string())?; Ok(json!(current(app, &id)?))
        }
        Err(error) => { pages.lock().unwrap().remove(&id); Err(error.to_string()) }
    }
}
async fn execute(app: &tauri::AppHandle, job: &Value) -> Result<Value, String> {
    let id = field(job, "id")?; let page_id = field(job, "pageId")?;
    if !identifier(id) || !identifier(page_id) { return Err("웹 요청 식별자가 올바르지 않습니다.".into()); }
    let state = app.state::<SharedBrowser>();
    let queue = state.queues.lock().unwrap().entry(page_id.to_string()).or_insert_with(|| Arc::new(tauri::async_runtime::Mutex::new(()))).clone();
    let _owned_page = queue.lock().await;
    if let Some(result) = state.receipts.lock().unwrap().get(id) { return Ok(result.clone()); }
    if state.running.lock().unwrap().contains(id) { return Err("이 요청이 이미 실행 중입니다. 결과를 기다려 주세요.".into()); }
    if state.receipts.lock().unwrap().len() >= 10000 { return Err("웹 동작 기록이 가득 찼습니다. 앱을 다시 시작한 뒤 새 탭을 열어 주세요.".into()); }
    state.running.lock().unwrap().insert(id.to_string());
    let outcome = execute_inner(app, job).await;
    let result = match outcome { Ok(value) => value, Err(error) => {
        let mut result = json!({ "id":id, "pageId":page_id, "error":error });
        if error.contains("응답을 확인하지 못") || error.contains("응답을 읽지 못") { result["outcome"] = json!("unknown"); }
        result
    } };
    state.running.lock().unwrap().remove(id);
    state.receipts.lock().unwrap().insert(id.to_string(), result.clone());
    Ok(result)
}
async fn execute_inner(app: &tauri::AppHandle, job: &Value) -> Result<Value, String> {
    let id = field(job, "id")?; let page_id = field(job, "pageId")?;
    if job["deadline"].as_u64().unwrap_or(0) < now() { return Err("REQUEST_EXPIRED: 이전 요청을 실행하지 않았습니다.".into()); }
    let action = &job["action"]; let kind = field(action, "kind")?;
    let page = current(app, page_id)?;
    let control: Control = serde_json::from_value(job["control"].clone()).map_err(|_| "제어권 정보가 올바르지 않습니다.")?;
    let view = app.get_webview(&label(page_id)).ok_or("웹 페이지가 닫혔습니다.")?;
    if kind != "snapshot" && kind != "control" && control != page.control { return Err("CONTROL_REVOKED".into()); }
    if kind == "control" {
        if control.generation < page.control.generation || (control.generation == page.control.generation && control.owner != page.control.owner) { return Err("CONTROL_REVOKED".into()); }
        if let Some(record) = app.state::<SharedBrowser>().pages.lock().unwrap().get_mut(page_id) { record.control = control.clone(); }
    }
    let expected = &job["expected"];
    if !expected.is_null() && (expected["target"]["pageId"] != page_id || expected["target"]["profileId"] != page.profile_id || expected["target"]["navigationRevision"].as_u64() != Some(page.navigation_revision)) { return Err("STALE_DOCUMENT".into()); }
    let run = format!("api.run({}, {}, {})", action, json!(control), expected.get("documentNonce").unwrap_or(&Value::Null));
    let expression = if kind == "navigate" {
        let target = allowed_url(app, field(action, "url")?)?;
        api_expression(&format!("(()=>{{const result={run};if(!result.error)location.assign({});return result;}})()", json!(target.as_str())))
    } else { api_expression(&run) };
    let value = evaluate(view.clone(), expression).await?;
    update_control(app, page_id, &value);
    if let Some(error) = value["error"].as_str() { return Err(error.to_string()); }
    // The actual page can navigate while a callback is in flight. Never relabel old observations.
    if kind == "snapshot" && current(app, page_id)?.navigation_revision != page.navigation_revision { return Err("STALE_DOCUMENT".into()); }
    if kind == "control" && current(app, page_id)?.control != control { return Err("CONTROL_REVOKED".into()); }
    match kind {
        "navigate" => (),
        "back" | "forward" | "reload" | "stop" => {
            // Recheck the document fence in the same JS action that navigates. No delayed raw navigation.
            let operation = match kind { "back" => "history.back()", "forward" => "history.forward()", "reload" => "location.reload()", _ => "window.stop()" };
            let script = api_expression(&format!("(()=>{{const checked=api.run({}, {}, null);if(checked.error)return checked;{operation};return checked;}})()", action, json!(control)));
            let checked = evaluate(view.clone(), script).await?;
            if let Some(error) = checked["error"].as_str() { return Err(error.into()); }
        }
        "close" => { platform::detach(&view, page_id)?; view.close().map_err(|e| e.to_string())?; app.state::<SharedBrowser>().pages.lock().unwrap().remove(page_id); return Ok(json!({"id":id,"pageId":page_id})); }
        "snapshot" | "control" | "click" | "fill" | "select" | "press" | "scroll" => (),
        _ => return Err("지원하지 않는 웹 동작입니다.".into()),
    }
    let fresh = current(app, page_id)?;
    let mut result = json!({"id":id,"pageId":page_id,"page":fresh});
    if kind == "snapshot" {
        result["observation"] = json!({"target":{"pageId":page_id,"profileId":page.profile_id,"navigationRevision":page.navigation_revision,"capabilities":page.capabilities},"documentNonce":value["documentNonce"],"observedAt":now(),"text":value["text"]});
    }
    Ok(result)
}

#[tauri::command]
pub async fn shared_browser(app: tauri::AppHandle, webview: Webview, command: Value) -> Result<Value, String> {
    // Check the calling WEBVIEW, not its containing window: remote children also live in main.
    if webview.label() != "main" { return Err("기본 앱 화면에서만 웹 탭을 관리할 수 있습니다.".into()); }
    match field(&command, "kind")? {
        "create" => create(&app, &webview, &command).await,
        "execute" => execute(&app, &command["job"]).await,
        "download-directory" => {
            let id = field(&command, "pageId")?; let page = current(&app, id)?;
            if page.control.owner != "human" { return Err("직접 조작으로 전환한 뒤 저장 폴더를 선택해 주세요.".into()); }
            let directory = if command["directory"].is_null() { None } else {
                let path = std::path::PathBuf::from(field(&command, "directory")?);
                let canonical = path.canonicalize().map_err(|error| error.to_string())?;
                if !path.is_absolute() || !canonical.is_dir() { return Err("다운로드를 저장할 폴더를 선택해 주세요.".into()); }
                Some(canonical.to_string_lossy().to_string())
            };
            if let Some(page) = app.state::<SharedBrowser>().pages.lock().unwrap().get_mut(id) { page.download_directory = directory; }
            Ok(json!(current(&app, id)?))
        }
        "permission-decision" => {
            let id = field(&command, "pageId")?.to_string(); let request_id = field(&command, "requestId")?.to_string();
            let page = current(&app, &id)?;
            if page.control.owner != "human" { return Err("직접 조작으로 전환한 뒤 권한을 결정해 주세요.".into()); }
            let allow = command["allow"].as_bool().ok_or("허용 또는 거절을 선택해 주세요.")?;
            let view = app.get_webview(&label(&id)).ok_or("웹 페이지가 닫혔습니다.")?;
            let remember = command["remember"].as_bool().unwrap_or(false);
            if remember && !page.capabilities.iter().any(|capability| capability == "permission_persistence") { return Err("이 환경에서는 요청별 권한만 결정할 수 있습니다.".into()); }
            platform::decide(view, app.state::<SharedBrowser>().pages.clone(), id.clone(), request_id, allow, remember).await?;
            Ok(json!(current(&app, &id)?))
        }
        "site-permission-forget" => {
            let id = field(&command, "pageId")?; let rule_id = field(&command, "ruleId")?; let page = current(&app, id)?;
            if page.control.owner != "human" { return Err("직접 조작으로 전환한 뒤 저장된 권한을 삭제해 주세요.".into()); }
            let origin = page.permission_store.remove(&page.profile_id, rule_id)?;
            let pages = app.state::<SharedBrowser>().pages.clone(); platform::permissions::refresh(&pages, &page.profile_id);
            let affected: Vec<_> = pages.lock().unwrap().values_mut().filter(|candidate| candidate.profile_id == page.profile_id && platform::permissions::origin(&candidate.url).as_deref() == Some(origin.as_str())).map(|page| {
                page.control = Control { generation: page.control.generation + 1, owner: "human".into() }; (page.page_id.clone(), page.control.clone())
            }).collect();
            // The button explicitly includes reloading this profile's affected tabs: active documents
            // do not retain a camera/microphone grant that the person just removed.
            for (page_id, control) in affected { if let Some(view) = app.get_webview(&label(&page_id)) {
                let action = json!({"kind":"control","control":control});
                let _ = evaluate(view.clone(), api_expression(&format!("api.run({action}, {}, null)", json!(control)))).await;
                platform::reset_permission(&view, &page_id)?; view.reload().map_err(|error| error.to_string())?;
            } }
            Ok(json!(current(&app, id)?))
        }
        "download-cancel" => {
            let id = field(&command, "pageId")?.to_string(); let download_id = field(&command, "downloadId")?.to_string();
            if current(&app, &id)?.control.owner != "human" { return Err("직접 조작으로 전환한 뒤 다운로드를 취소해 주세요.".into()); }
            let view = app.get_webview(&label(&id)).ok_or("웹 페이지가 닫혔습니다.")?;
            platform::cancel_download(view, app.state::<SharedBrowser>().pages.clone(), id.clone(), download_id).await?;
            Ok(json!(current(&app, &id)?))
        }
        "list" => {
            let pages: Vec<Page> = app.state::<SharedBrowser>().pages.lock().unwrap().values().cloned().collect();
            for page in pages {
                if let Some(view) = app.get_webview(&label(&page.page_id)) {
                    // User input happens only on a visible page. Hidden pages keep the actual DOM/run.
                    if page.visible && !page.loading {
                        if let Ok(value) = evaluate(view, api_expression(&format!("api.state({})", json!(page.control)))).await { update_control(&app, &page.page_id, &value); }
                    }
                } else { app.state::<SharedBrowser>().pages.lock().unwrap().remove(&page.page_id); }
            }
            Ok(json!(app.state::<SharedBrowser>().pages.lock().unwrap().values().cloned().collect::<Vec<_>>()))
        }
        "present" => {
            let placements = command["pages"].as_array().ok_or("웹 페이지 위치가 올바르지 않습니다.")?;
            let pages: Vec<Page> = app.state::<SharedBrowser>().pages.lock().unwrap().values().cloned().collect();
            for page in pages {
                let Some(view) = app.get_webview(&label(&page.page_id)) else { continue };
                let position = placements.iter().find(|p| p["pageId"] == page.page_id && p["visible"] == true);
                if let Some(position) = position {
                    let number = |key: &str| position[key].as_f64().filter(|n| n.is_finite()).unwrap_or(0.0);
                    let width = number("width"); let height = number("height");
                    if width <= 1.0 || height <= 1.0 { let _ = view.hide(); continue; }
                    view.set_bounds(tauri::Rect { position: LogicalPosition::new(number("x"), number("y")).into(), size: LogicalSize::new(width, height).into() }).map_err(|e| e.to_string())?;
                    view.show().map_err(|e| e.to_string())?;
                    if position["focus"] == true { view.set_focus().map_err(|e| e.to_string())?; }
                } else { view.hide().map_err(|e| e.to_string())?; }
                if let Some(record) = app.state::<SharedBrowser>().pages.lock().unwrap().get_mut(&page.page_id) { record.visible = position.is_some(); }
            }
            Ok(Value::Null)
        }
        _ => Err("지원하지 않는 브라우저 요청입니다.".into()),
    }
}

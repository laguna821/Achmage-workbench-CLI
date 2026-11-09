//! WebView2 0.39 SDK callbacks on the owning UI thread; operation identities never come from URL matching.
use std::{cell::RefCell, collections::HashMap, path::PathBuf, sync::{Arc, Mutex}};
use tauri::{Manager, Webview};
use windows::core::{Interface, HSTRING, PWSTR};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, DownloadStartingEventHandler, PermissionRequestedEventHandler, StateChangedEventHandler, take_pwstr};
use super::{Page, permissions};
type Pages = Arc<Mutex<HashMap<String, Page>>>;
struct Download { operation: ICoreWebView2DownloadOperation, token: i64 }
struct Pending { page_id: String, request: permissions::Request, args: ICoreWebView2PermissionRequestedEventArgs, deferral: ICoreWebView2Deferral, pages: Pages }
struct Registration { core: ICoreWebView2, downloads: ICoreWebView2_4, permission_token: i64, download_token: i64 }
thread_local! {
    static DOWNLOADS: RefCell<HashMap<(String,String),Download>> = RefCell::new(HashMap::new());
    static REQUESTS: RefCell<HashMap<String,Pending>> = RefCell::new(HashMap::new());
    static REGISTRATIONS: RefCell<HashMap<String,Registration>> = RefCell::new(HashMap::new());
}
fn kind(kind: COREWEBVIEW2_PERMISSION_KIND) -> &'static str {
    match kind {
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE => "microphone", COREWEBVIEW2_PERMISSION_KIND_CAMERA => "camera", COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION => "geolocation",
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS => "notifications", COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ => "clipboard-read", COREWEBVIEW2_PERMISSION_KIND_LOCAL_FONTS => "local-fonts",
        COREWEBVIEW2_PERMISSION_KIND_OTHER_SENSORS => "sensors", COREWEBVIEW2_PERMISSION_KIND_MIDI_SYSTEM_EXCLUSIVE_MESSAGES => "midi", COREWEBVIEW2_PERMISSION_KIND_MULTIPLE_AUTOMATIC_DOWNLOADS => "automatic-downloads",
        COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE => "file-system-access", COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY => "autoplay", COREWEBVIEW2_PERMISSION_KIND_WINDOW_MANAGEMENT => "window-management", _ => "other",
    }
}
fn finish(id: &str, pending: Pending, status: &str, allow: bool, remember: bool) -> Result<(), String> {
    let result = unsafe { pending.args.SetState(if allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY }) };
    let completed = unsafe { pending.deferral.Complete() };
    permissions::settle(&pending.pages, &pending.page_id, id, if result.is_ok() && completed.is_ok() { status } else { "expired" }, remember);
    result.and(completed).map_err(|error| error.to_string())
}
fn expire(id: &str) { let pending = REQUESTS.with(|requests| requests.borrow_mut().remove(id)); if let Some(pending) = pending { let _ = finish(id, pending, "expired", false, false); } }
pub fn invalidate(page_id: &str) {
    let ids = REQUESTS.with(|requests| requests.borrow().iter().filter(|(_,pending)| pending.page_id == page_id).map(|(id,_)| id.clone()).collect::<Vec<_>>());
    for id in ids { expire(&id); }
}
pub fn detach(page_id: &str) {
    invalidate(page_id);
    if let Some(registration) = REGISTRATIONS.with(|entries| entries.borrow_mut().remove(page_id)) { unsafe { let _ = registration.core.remove_PermissionRequested(registration.permission_token); let _ = registration.downloads.remove_DownloadStarting(registration.download_token); } }
    let keys = DOWNLOADS.with(|downloads| downloads.borrow().keys().filter(|(page,_)| page == page_id).cloned().collect::<Vec<_>>());
    for key in keys { if let Some(download) = DOWNLOADS.with(|downloads| downloads.borrow_mut().remove(&key)) { unsafe { let _ = download.operation.remove_StateChanged(download.token); let _ = download.operation.Cancel(); } } }
}
pub fn attach(view: &Webview, pages: Pages, page_id: String) -> Result<(), String> {
    let app = view.app_handle().clone();
    view.with_webview(move |native| {
        let result = unsafe { install(native.controller().CoreWebView2(), app, pages.clone(), page_id.clone()) };
        if let Err(error) = result { if let Some(page) = pages.lock().unwrap().get_mut(&page_id) { page.capabilities.retain(|capability| !["downloads", "download_cancel", "permission_decision", "permission_persistence"].contains(&capability.as_str())); page.error = Some(format!("다운로드·권한 API를 연결하지 못했습니다: {error}")); } }
    }).map_err(|error| error.to_string())
}
unsafe fn install(core: windows::core::Result<ICoreWebView2>, app: tauri::AppHandle, pages: Pages, page_id: String) -> windows::core::Result<()> {
    let core = core?; let downloads: ICoreWebView2_4 = core.cast()?; let mut download_token = 0;
    let download_pages = pages.clone(); let download_page = page_id.clone();
    downloads.add_DownloadStarting(&DownloadStartingEventHandler::create(Box::new(move |_,args| {
        let Some(args) = args else { return Ok(()); };
        let operation = args.DownloadOperation()?; let mut raw = PWSTR::null(); operation.Uri(&mut raw)?; let url = take_pwstr(raw);
        let mut raw = PWSTR::null(); args.ResultFilePath(&mut raw)?; let mut path = PathBuf::from(take_pwstr(raw));
        let Some(id) = super::requested_id(&download_pages, &download_page, &url, &mut path) else { args.SetCancel(true)?; return Ok(()); };
        let key = (download_page.clone(), id.clone()); let completed_key = key.clone(); let completed_pages = download_pages.clone(); let completed_path = path.clone(); let mut token = 0;
        let configured = (|| -> windows::core::Result<()> {
            args.SetResultFilePath(&HSTRING::from(path.to_string_lossy().as_ref()))?; args.SetHandled(true)?;
            operation.add_StateChanged(&StateChangedEventHandler::create(Box::new(move |operation,_| {
                let Some(operation) = operation else { return Ok(()); }; let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default(); operation.State(&mut state)?;
                if state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS { return Ok(()); }
                if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED { super::finished_id(&completed_pages, &completed_key.0, &completed_key.1, Some(&completed_path), true); }
                else { let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default(); operation.InterruptReason(&mut reason)?;
                    if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED { super::download_state(&completed_pages, &completed_key.0, &completed_key.1, "cancelled", None); }
                    else { super::download_state(&completed_pages, &completed_key.0, &completed_key.1, "failed", Some("브라우저가 다운로드를 중단했습니다. 사이트에서 다시 시도해 주세요.")); }
                }
                if let Some(download) = DOWNLOADS.with(|downloads| downloads.borrow_mut().remove(&completed_key)) { let _ = download.operation.remove_StateChanged(download.token); }
                Ok(())
            })), &mut token)?; Ok(())
        })();
        if let Err(error) = configured { let _ = args.SetCancel(true); super::download_state(&download_pages, &download_page, &id, "failed", Some("브라우저 다운로드 저장 경로를 적용하지 못했습니다.")); return Err(error); }
        DOWNLOADS.with(|downloads| downloads.borrow_mut().insert(key, Download { operation, token })); Ok(())
    })), &mut download_token)?;
    let permission_pages = pages.clone(); let permission_page = page_id.clone(); let mut permission_token = 0;
    let permission_result = core.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(move |source,args| {
        let Some(args) = args else { return Ok(()); }; args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
        let mut native_kind = COREWEBVIEW2_PERMISSION_KIND::default(); args.PermissionKind(&mut native_kind)?; let kind = kind(native_kind);
        let mut raw = PWSTR::null(); args.Uri(&mut raw)?; let origin = permissions::origin(&take_pwstr(raw));
        let mut top = PWSTR::null(); let top = if let Some(source) = source { source.Source(&mut top)?; permissions::origin(&take_pwstr(top)) } else { None };
        let Some(request) = permissions::request(&permission_pages, &permission_page, kind, origin, top) else { return Ok(()); };
        // Do not let an engine-managed remembered grant bypass this profile+embedding-origin store.
        let explicit = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>().and_then(|version| { version.SetSavesInProfile(false)?; version.SetHandled(true) });
        if kind == "other" || explicit.is_err() {
            permissions::settle(&permission_pages, &permission_page, &request.id, "unsupported", false);
            if explicit.is_err() { if let Some(page) = permission_pages.lock().unwrap().get_mut(&permission_page) { page.capabilities.retain(|capability| !["permission_decision", "permission_persistence"].contains(&capability.as_str())); page.error = Some("현재 WebView2는 앱이 관리하는 사이트 권한을 지원하지 않습니다. 브라우저 런타임을 업데이트해 주세요.".into()); } }
            return Ok(());
        }
        if let Some(allow) = request.saved {
            let result = args.SetState(if allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY });
            if result.is_err() { permissions::settle(&permission_pages, &permission_page, &request.id, "expired", false); } result?; return Ok(());
        }
        let deferral = match args.GetDeferral() { Ok(value) => value, Err(error) => { permissions::settle(&permission_pages, &permission_page, &request.id, "expired", false); return Err(error); } }; let id = request.id.clone();
        REQUESTS.with(|requests| requests.borrow_mut().insert(id.clone(), Pending { page_id: permission_page.clone(), request, args, deferral, pages: permission_pages.clone() }));
        let timeout_app = app.clone(); tauri::async_runtime::spawn(async move { tokio::time::sleep(std::time::Duration::from_secs(60)).await; let _ = timeout_app.run_on_main_thread(move || expire(&id)); }); Ok(())
    })), &mut permission_token);
    if let Err(error) = permission_result { let _ = downloads.remove_DownloadStarting(download_token); return Err(error); }
    REGISTRATIONS.with(|entries| entries.borrow_mut().insert(page_id.clone(), Registration { core, downloads, permission_token, download_token }));
    if let Some(page) = pages.lock().unwrap().get_mut(&page_id) { page.capabilities.extend(["download_cancel", "permission_decision", "permission_persistence"].map(str::to_string)); }
    Ok(())
}
pub fn decide(pages: &Pages, page_id: &str, request_id: &str, allow: bool, remember: bool) -> Result<(), String> {
    let pending = REQUESTS.with(|requests| requests.borrow_mut().remove(request_id)).ok_or("권한 요청이 만료되었거나 이미 처리되었습니다.")?;
    if pending.page_id != page_id { let _ = finish(request_id, pending, "expired", false, false); return Err("다른 웹 탭의 권한 요청입니다.".into()); }
    let prepared = permissions::prepare(pages, page_id, request_id, pending.request.revision, pending.request.expires, allow, remember);
    if let Err(error) = prepared { let _ = finish(request_id, pending, "expired", false, false); return Err(error); }
    finish(request_id, pending, if allow { "allowed" } else { "denied" }, allow, remember)
}
pub fn cancel(pages: &Pages, page_id: &str, download_id: &str) -> Result<(), String> {
    let operation = DOWNLOADS.with(|downloads| downloads.borrow().get(&(page_id.to_string(), download_id.to_string())).map(|download| download.operation.clone())).ok_or("진행 중인 다운로드 객체를 찾지 못했습니다.")?;
    super::download_state(pages, page_id, download_id, "cancelling", None);
    if let Err(error) = unsafe { operation.Cancel() } { super::download_state(pages, page_id, download_id, "downloading", Some("취소 요청을 전달하지 못했습니다.")); return Err(error.to_string()); }
    Ok(())
}

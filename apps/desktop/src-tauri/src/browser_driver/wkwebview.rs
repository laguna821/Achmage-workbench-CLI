//! Retain Wry's delegates and forward every untouched selector. Only download and media permission callbacks are adapted.
use std::{cell::RefCell, collections::HashMap, path::PathBuf, sync::{Arc, Mutex}};
use block2::{DynBlock, RcBlock};
use objc2::{define_class, msg_send, rc::Retained, runtime::{AnyClass, AnyObject, NSObject, ProtocolObject, Sel}, DeclaredClass, MainThreadOnly, MainThreadMarker};
use objc2_foundation::{NSData, NSError, NSObjectProtocol, NSString, NSURL, NSURLResponse};
use objc2_web_kit::{WKDownload, WKDownloadDelegate, WKFrameInfo, WKMediaCaptureType, WKNavigationAction, WKNavigationDelegate, WKNavigationResponse, WKPermissionDecision, WKSecurityOrigin, WKUIDelegate, WKWebView};
use tauri::{Manager, Webview};
use super::{Page, permissions};
type Pages = Arc<Mutex<HashMap<String, Page>>>;
#[derive(Clone)]
struct Context { pages: Pages, page_id: String, app: tauri::AppHandle }
struct Download { native: Retained<WKDownload>, _delegate: Retained<DownloadDelegate> }
struct Pending { context: Context, request: permissions::Request, callback: RcBlock<dyn Fn(WKPermissionDecision)> }
struct Delegates { webview: Retained<WKWebView>, navigation: Retained<NavigationDelegate>, ui: Retained<UiDelegate> }
thread_local! {
    static DOWNLOADS: RefCell<HashMap<(String,String),Download>> = RefCell::new(HashMap::new());
    static REQUESTS: RefCell<HashMap<String,Pending>> = RefCell::new(HashMap::new());
    static DELEGATES: RefCell<HashMap<String,Delegates>> = RefCell::new(HashMap::new());
}
struct NavigationIvars { original: Retained<ProtocolObject<dyn WKNavigationDelegate>>, context: Context }
struct UiIvars { original: Retained<ProtocolObject<dyn WKUIDelegate>>, context: Context }
struct DownloadIvars { context: Context, id: RefCell<Option<String>>, destination: RefCell<Option<PathBuf>> }

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "WorkbenchSharedPageNavigationDelegate"]
    #[thread_kind = MainThreadOnly]
    #[ivars = NavigationIvars]
    struct NavigationDelegate;
    unsafe impl NSObjectProtocol for NavigationDelegate {}
    impl NavigationDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds(&self, selector: Sel) -> bool { unsafe { let own: bool = msg_send![super(self), respondsToSelector: selector]; own || msg_send![&*self.ivars().original, respondsToSelector: selector] } }
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forward(&self, _selector: Sel) -> *mut AnyObject { Retained::as_ptr(&self.ivars().original).cast::<AnyObject>().cast_mut() }
    }
    unsafe impl WKNavigationDelegate for NavigationDelegate {
        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        fn action_download(&self, _view: &WKWebView, _action: &WKNavigationAction, download: &WKDownload) { attach_download(self.ivars().context.clone(), download); }
        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        fn response_download(&self, _view: &WKWebView, _response: &WKNavigationResponse, download: &WKDownload) { attach_download(self.ivars().context.clone(), download); }
    }
);
define_class!(
    #[unsafe(super(NSObject))]
    #[name = "WorkbenchSharedPageUiDelegate"]
    #[thread_kind = MainThreadOnly]
    #[ivars = UiIvars]
    struct UiDelegate;
    unsafe impl NSObjectProtocol for UiDelegate {}
    impl UiDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds(&self, selector: Sel) -> bool { unsafe { let own: bool = msg_send![super(self), respondsToSelector: selector]; own || msg_send![&*self.ivars().original, respondsToSelector: selector] } }
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forward(&self, _selector: Sel) -> *mut AnyObject { Retained::as_ptr(&self.ivars().original).cast::<AnyObject>().cast_mut() }
    }
    unsafe impl WKUIDelegate for UiDelegate {
        #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
        fn media_permission(&self, view: &WKWebView, origin: &WKSecurityOrigin, frame: &WKFrameInfo, kind: WKMediaCaptureType, callback: &DynBlock<dyn Fn(WKPermissionDecision)>) {
            let kind = if kind == WKMediaCaptureType::Camera { "camera" } else if kind == WKMediaCaptureType::Microphone { "microphone" } else if kind == WKMediaCaptureType::CameraAndMicrophone { "camera-microphone" } else { "other" };
            let _ = origin; // The initiating frame's security origin is authoritative for embedded requests.
            let requester = unsafe { security_origin(&frame.securityOrigin()) };
            let context = self.ivars().context.clone();
            let top = unsafe { view.URL().and_then(|url| url.absoluteString()).and_then(|value| permissions::origin(&value.to_string())) };
            let Some(request) = permissions::request(&context.pages, &context.page_id, kind, requester, top) else { callback.call((WKPermissionDecision::Deny,)); return; };
            if kind == "other" { permissions::settle(&context.pages, &context.page_id, &request.id, "unsupported", false); callback.call((WKPermissionDecision::Deny,)); return; }
            if let Some(allow) = request.saved { callback.call((if allow { WKPermissionDecision::Grant } else { WKPermissionDecision::Deny },)); return; }
            let Some(callback) = (unsafe { RcBlock::copy((callback as *const DynBlock<dyn Fn(WKPermissionDecision)>).cast_mut()) }) else { permissions::settle(&context.pages, &context.page_id, &request.id, "expired", false); callback.call((WKPermissionDecision::Deny,)); return; };
            let id = request.id.clone(); let app = context.app.clone();
            REQUESTS.with(|requests| requests.borrow_mut().insert(id.clone(), Pending { context, request, callback }));
            tauri::async_runtime::spawn(async move { tokio::time::sleep(std::time::Duration::from_secs(60)).await; let _ = app.run_on_main_thread(move || expire(&id)); });
        }
    }
);
define_class!(
    #[unsafe(super(NSObject))]
    #[name = "WorkbenchSharedPageDownloadDelegate"]
    #[thread_kind = MainThreadOnly]
    #[ivars = DownloadIvars]
    struct DownloadDelegate;
    unsafe impl NSObjectProtocol for DownloadDelegate {}
    unsafe impl WKDownloadDelegate for DownloadDelegate {
        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        fn destination(&self, download: &WKDownload, _response: &NSURLResponse, name: &NSString, callback: &DynBlock<dyn Fn(*mut NSURL)>) {
            let _keep_alive = unsafe { Retained::retain((self as *const Self).cast_mut()) };
            let context = &self.ivars().context;
            let url = unsafe { download.originalRequest().and_then(|request| request.URL()).and_then(|url| url.absoluteString()).map(|value| value.to_string()) };
            let Some(url) = url else { callback.call((std::ptr::null_mut(),)); return; };
            let mut destination = PathBuf::from(name.to_string());
            let Some(id) = super::requested_id(&context.pages, &context.page_id, &url, &mut destination) else { callback.call((std::ptr::null_mut(),)); release_download(download); return; };
            *self.ivars().id.borrow_mut() = Some(id.clone()); *self.ivars().destination.borrow_mut() = Some(destination.clone());
            // Replace the temporary pointer identity with the immutable Workbench download identity.
            let entry = DOWNLOADS.with(|downloads| downloads.borrow_mut().remove(&(context.page_id.clone(), pointer_id(download))));
            if let Some(entry) = entry { DOWNLOADS.with(|downloads| downloads.borrow_mut().insert((context.page_id.clone(), id), entry)); }
            let path = unsafe { NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&destination.to_string_lossy()), false) };
            callback.call((Retained::as_ptr(&path).cast_mut(),));
        }
        #[unsafe(method(downloadDidFinish:))]
        fn completed(&self, download: &WKDownload) {
            let _keep_alive = unsafe { Retained::retain((self as *const Self).cast_mut()) };
            if let Some(id) = self.ivars().id.borrow().as_ref() { let context = &self.ivars().context; super::finished_id(&context.pages, &context.page_id, id, self.ivars().destination.borrow().as_deref(), true); }
            release_download(download);
        }
        #[unsafe(method(download:didFailWithError:resumeData:))]
        fn failed(&self, download: &WKDownload, _error: &NSError, _resume: Option<&NSData>) {
            let _keep_alive = unsafe { Retained::retain((self as *const Self).cast_mut()) };
            if let Some(id) = self.ivars().id.borrow().as_ref() {
                let context = &self.ivars().context;
                let cancelling = context.pages.lock().unwrap().get(&context.page_id).is_some_and(|page| page.downloads.iter().any(|entry| entry["id"] == *id && entry["status"] == "cancelling"));
                super::download_state(&context.pages, &context.page_id, id, if cancelling { "cancelled" } else { "failed" }, if cancelling { None } else { Some("브라우저가 다운로드를 중단했습니다. 사이트에서 다시 시도해 주세요.") });
            }
            release_download(download);
        }
    }
);
unsafe fn security_origin(origin: &WKSecurityOrigin) -> Option<String> {
    let scheme = origin.protocol().to_string(); let host = origin.host().to_string(); let port = origin.port();
    let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host };
    permissions::origin(&format!("{scheme}://{host}{}", if port > 0 { format!(":{port}") } else { String::new() }))
}
fn pointer_id(download: &WKDownload) -> String { format!("native-{:p}", download) }
fn release_download(download: &WKDownload) {
    DOWNLOADS.with(|downloads| { let key = downloads.borrow().iter().find(|(_,entry)| std::ptr::eq(&*entry.native, download)).map(|(key,_)| key.clone()); if let Some(key) = key { downloads.borrow_mut().remove(&key); } });
}
fn attach_download(context: Context, download: &WKDownload) {
    let Some(mtm) = MainThreadMarker::new() else { unsafe { download.cancel(None); } return; };
    unsafe {
        let allocated = mtm.alloc::<DownloadDelegate>().set_ivars(DownloadIvars { context: context.clone(), id: RefCell::new(None), destination: RefCell::new(None) });
        let delegate: Retained<DownloadDelegate> = msg_send![super(allocated), init];
        let native = Retained::retain((download as *const WKDownload).cast_mut()).unwrap();
        download.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        DOWNLOADS.with(|downloads| downloads.borrow_mut().insert((context.page_id, pointer_id(download)), Download { native, _delegate: delegate }));
    }
}
fn finish(pending: Pending, status: &str, allow: bool, remember: bool) {
    permissions::settle(&pending.context.pages, &pending.context.page_id, &pending.request.id, status, remember);
    pending.callback.call((if allow { WKPermissionDecision::Grant } else { WKPermissionDecision::Deny },));
}
fn expire(id: &str) { if let Some(pending) = REQUESTS.with(|requests| requests.borrow_mut().remove(id)) { finish(pending, "expired", false, false); } }
pub fn invalidate(page_id: &str) {
    let ids = REQUESTS.with(|requests| requests.borrow().iter().filter(|(_,pending)| pending.context.page_id == page_id).map(|(id,_)| id.clone()).collect::<Vec<_>>()); for id in ids { expire(&id); }
}
pub fn detach(page_id: &str) {
    invalidate(page_id);
    let keys = DOWNLOADS.with(|downloads| downloads.borrow().keys().filter(|(page,_)| page == page_id).cloned().collect::<Vec<_>>());
    for key in keys { if let Some(download) = DOWNLOADS.with(|downloads| downloads.borrow_mut().remove(&key)) { unsafe { download.native.setDelegate(None); download.native.cancel(None); } } }
    if let Some(delegates) = DELEGATES.with(|entries| entries.borrow_mut().remove(page_id)) { unsafe { delegates.webview.setNavigationDelegate(Some(&delegates.navigation.ivars().original)); delegates.webview.setUIDelegate(Some(&delegates.ui.ivars().original)); } }
}
pub fn attach(view: &Webview, pages: Pages, page_id: String) -> Result<(), String> {
    let app = view.app_handle().clone();
    view.with_webview(move |native| {
        let result = (|| -> Result<(), String> { unsafe {
            let mtm = MainThreadMarker::new().ok_or("브라우저 UI 스레드를 확인하지 못했습니다.")?;
            let webview = Retained::retain(native.inner().cast::<WKWebView>()).ok_or("웹 탭 객체가 없습니다.")?;
            let original = webview.navigationDelegate().ok_or("기존 브라우저 탐색 delegate가 없습니다.")?;
            let context = Context { pages: pages.clone(), page_id: page_id.clone(), app };
            let allocated = mtm.alloc::<NavigationDelegate>().set_ivars(NavigationIvars { original, context: context.clone() });
            let navigation: Retained<NavigationDelegate> = msg_send![super(allocated), init];
            let original = webview.UIDelegate().ok_or("기존 브라우저 UI delegate가 없습니다.")?;
            let allocated = mtm.alloc::<UiDelegate>().set_ivars(UiIvars { original, context }); let ui: Retained<UiDelegate> = msg_send![super(allocated), init];
            webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*navigation))); webview.setUIDelegate(Some(ProtocolObject::from_ref(&*ui)));
            DELEGATES.with(|entries| entries.borrow_mut().insert(page_id.clone(), Delegates { webview: webview.clone(), navigation, ui }));
            if let Some(page) = pages.lock().unwrap().get_mut(&page_id) {
                if AnyClass::get(c"WKDownload").is_some() { page.capabilities.push("download_cancel".into()); }
                if super::mac_version().is_some_and(|version| version >= (12,0)) { page.capabilities.extend(["permission_decision", "permission_persistence"].map(str::to_string)); }
            }
            Ok(())
        }})();
        if let Err(error) = result { if let Some(page) = pages.lock().unwrap().get_mut(&page_id) { page.error = Some(format!("다운로드·권한 API를 연결하지 못했습니다: {error}")); } }
    }).map_err(|error| error.to_string())
}
pub fn decide(pages: &Pages, page_id: &str, request_id: &str, allow: bool, remember: bool) -> Result<(), String> {
    let pending = REQUESTS.with(|requests| requests.borrow_mut().remove(request_id)).ok_or("권한 요청이 만료되었거나 이미 처리되었습니다.")?;
    if pending.context.page_id != page_id { finish(pending, "expired", false, false); return Err("다른 웹 탭의 권한 요청입니다.".into()); }
    if let Err(error) = permissions::prepare(pages, page_id, request_id, pending.request.revision, pending.request.expires, allow, remember) { finish(pending, "expired", false, false); return Err(error); }
    finish(pending, if allow { "allowed" } else { "denied" }, allow, remember); Ok(())
}
pub fn cancel(pages: &Pages, page_id: &str, download_id: &str) -> Result<(), String> {
    let download = DOWNLOADS.with(|downloads| downloads.borrow().get(&(page_id.to_string(), download_id.to_string())).map(|download| download.native.clone())).ok_or("진행 중인 다운로드 객체를 찾지 못했습니다.")?;
    super::download_state(pages, page_id, download_id, "cancelling", None);
    let pages = pages.clone(); let page = page_id.to_string(); let id = download_id.to_string();
    let callback = RcBlock::new(move |_resume: *mut NSData| {
        let cancelling = pages.lock().unwrap().get(&page).is_some_and(|page| page.downloads.iter().any(|entry| entry["id"] == id && entry["status"] == "cancelling"));
        if cancelling { super::download_state(&pages, &page, &id, "cancelled", None); }
        DOWNLOADS.with(|downloads| downloads.borrow_mut().remove(&(page.clone(), id.clone())));
    });
    unsafe { download.cancel(Some(&callback)); } Ok(())
}
pub fn stop_capture(view: &WKWebView) {
    if super::mac_version().is_some_and(|version| version >= (12,0)) { unsafe {
        view.setCameraCaptureState_completionHandler(objc2_web_kit::WKMediaCaptureState::None, None);
        view.setMicrophoneCaptureState_completionHandler(objc2_web_kit::WKMediaCaptureState::None, None);
    } }
}

//! Hold the real GTK request on its owning thread until a person answers in the app.
use std::{cell::{Cell, RefCell}, collections::HashMap, path::PathBuf, rc::Rc, sync::{Arc, Mutex}, time::Duration};
use serde_json::json;
use tauri::Webview;
use gtk::glib::prelude::*;
use gtk::prelude::*;
use webkit2gtk::{Download, DownloadExt, PermissionRequest, PermissionRequestExt, URIRequestExt, UserMediaPermissionRequestExt, WebContextExt, WebViewExt};
use super::{Page, new_id, now};

type Pages = Arc<Mutex<HashMap<String, Page>>>;
struct Pending { page_id: String, revision: u64, expires: u64, request: PermissionRequest, pages: Pages }
thread_local! {
    static REQUESTS: RefCell<HashMap<String, Pending>> = RefCell::new(HashMap::new());
    static DOWNLOADS: RefCell<HashMap<(String, String), Download>> = RefCell::new(HashMap::new());
    static PAGE_LAYER: RefCell<Option<gtk::Fixed>> = const { RefCell::new(None) };
}

// Tauri creates GTK children in its vertical box. Wry ignores set_bounds for those
// children, so a shared page otherwise divides the window into two stacked views.
fn embed_page(webview: &webkit2gtk::WebView) -> Result<(), String> {
    let parent = webview.parent().and_then(|parent| parent.downcast::<gtk::Box>().ok())
        .ok_or("웹 페이지의 앱 표시 영역을 찾지 못했습니다.")?;
    let layer = PAGE_LAYER.with(|slot| {
        if let Some(layer) = slot.borrow().as_ref() { return layer.clone(); }
        let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
        for child in parent.children() {
            if child == webview.clone().upcast::<gtk::Widget>() { continue; }
            let (expand, fill, padding, pack) = parent.query_child_packing(&child);
            parent.remove(&child);
            if pack == gtk::PackType::End { content.pack_end(&child, expand, fill, padding); }
            else { content.pack_start(&child, expand, fill, padding); }
        }
        let layer = gtk::Fixed::new();
        let overlay = gtk::Overlay::new();
        overlay.add(&content);
        overlay.add_overlay(&layer);
        parent.pack_start(&overlay, true, true, 0);
        // Do not show_all: hidden Office renderer webviews must stay hidden.
        content.show(); layer.show(); overlay.show();
        *slot.borrow_mut() = Some(layer.clone());
        layer
    });
    parent.remove(webview);
    layer.put(webview, 0, 0);
    webview.set_size_request(1, 1);
    webview.hide();
    Ok(())
}

pub fn set_bounds(view: &Webview, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    view.with_webview(move |native| {
        let webview = native.inner();
        if let Some(layer) = webview.parent().and_then(|parent| parent.downcast::<gtk::Fixed>().ok()) {
            let (x, y, width, height) = (x.round() as i32, y.round() as i32, width.round() as i32, height.round() as i32);
            webview.set_size_request(width, height);
            layer.move_(&webview, x, y);
            webview.size_allocate(&gtk::Allocation::new(x, y, width, height));
        }
    }).map_err(|error| error.to_string())
}

fn finish_permission(id: &str, pending: Pending, status: &str, allow: bool) {
    if allow { pending.request.allow(); } else { pending.request.deny(); }
    if let Some(page) = pending.pages.lock().unwrap().get_mut(&pending.page_id) {
        if let Some(entry) = page.permissions.iter_mut().find(|entry| entry["id"] == id) { entry["status"] = json!(status); }
    }
}

pub fn invalidate(page_id: &str) {
    REQUESTS.with(|requests| {
        let ids: Vec<String> = requests.borrow().iter().filter(|(_, pending)| pending.page_id == page_id).map(|(id, _)| id.clone()).collect();
        for id in ids { let pending = requests.borrow_mut().remove(&id); if let Some(pending) = pending { finish_permission(&id, pending, "expired", false); } }
    });
}

pub fn detach(page_id: &str) {
    invalidate(page_id);
    DOWNLOADS.with(|downloads| {
        let keys: Vec<_> = downloads.borrow().keys().filter(|(page, _)| page == page_id).cloned().collect();
        for key in keys { let download = downloads.borrow_mut().remove(&key); if let Some(download) = download { download.cancel(); } }
    });
}

pub fn attach(view: &Webview, pages: Pages, page_id: String) -> Result<(), String> {
    view.with_webview(move |native| {
        let webview = native.inner();
        if let Err(error) = embed_page(&webview) {
            if let Some(page) = pages.lock().unwrap().get_mut(&page_id) { page.error = Some(error); }
            return;
        }
        let permission_pages = pages.clone(); let permission_page = page_id.clone();
        webview.connect_permission_request(move |_, request| {
            let kind = if let Some(media) = request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() {
                match (media.is_for_audio_device(), media.is_for_video_device()) { (true, true) => "camera-microphone", (true, false) => "microphone", (false, true) => "camera", _ => "display-capture" }
            } else if request.is::<webkit2gtk::GeolocationPermissionRequest>() { "geolocation" }
            else if request.is::<webkit2gtk::NotificationPermissionRequest>() { "notifications" }
            else if request.is::<webkit2gtk::PointerLockPermissionRequest>() { "pointer-lock" } else { "other" };
            let id = new_id(); let expires = now() + 60_000;
            let revision = {
                let mut pages = permission_pages.lock().unwrap(); let Some(page) = pages.get_mut(&permission_page) else { request.deny(); return true; };
                if page.permissions.len() >= 80 { page.permissions.remove(0); }
                page.permissions.push(json!({"id":id,"kind":kind,"pageUrl":page.url,"navigationRevision":page.navigation_revision,"requestingOrigin":null,"requestedAt":now(),"expiresAt":expires,"status":if kind == "other" {"unsupported"} else {"pending"}}));
                page.navigation_revision
            };
            if kind == "other" { request.deny(); return true; }
            REQUESTS.with(|requests| { requests.borrow_mut().insert(id.clone(), Pending { page_id: permission_page.clone(), revision, expires, request: request.clone(), pages: permission_pages.clone() }); });
            gtk::glib::timeout_add_local_once(Duration::from_secs(60), move || {
                REQUESTS.with(|requests| { let pending = requests.borrow_mut().remove(&id); if let Some(pending) = pending { finish_permission(&id, pending, "expired", false); } });
            });
            true
        });
        if let Some(context) = webview.context() {
            let watched = webview.clone();
            context.connect_download_started(move |_, download| {
                if download.web_view().as_ref() != Some(&watched) { return; }
                let Some(url) = download.request().and_then(|request| request.uri()).map(|url| url.to_string()) else { return; };
                let key = (page_id.clone(), url.clone());
                let accepted = Rc::new(Cell::new(false)); let failed = Rc::new(Cell::new(false));
                let destination_pages = pages.clone(); let destination_page = page_id.clone(); let destination_url = url.clone(); let destination_key = key.clone(); let was_accepted = accepted.clone();
                download.connect_decide_destination(move |download, suggested| {
                    let mut destination = PathBuf::from(suggested);
                    if !super::requested(&destination_pages, &destination_page, &destination_url, &mut destination) { download.cancel(); return true; }
                    match tauri::Url::from_file_path(&destination) {
                        Ok(uri) => { was_accepted.set(true); DOWNLOADS.with(|downloads| { downloads.borrow_mut().insert(destination_key.clone(), download.clone()); }); download.set_allow_overwrite(false); download.set_destination(uri.as_str()); },
                        Err(_) => { super::finished(&destination_pages, &destination_page, &destination_url, Some(&destination), false); download.cancel(); },
                    }
                    true
                });
                let was_failed = failed.clone(); download.connect_failed(move |_, _| { was_failed.set(true); });
                let finished_pages = pages.clone(); let finished_page = page_id.clone();
                download.connect_finished(move |download| {
                    DOWNLOADS.with(|downloads| { let mut downloads = downloads.borrow_mut(); if downloads.get(&key) == Some(download) { downloads.remove(&key); } });
                    if accepted.get() {
                        let path = download.destination().and_then(|value| tauri::Url::parse(value.as_str()).ok()).and_then(|url| url.to_file_path().ok());
                        super::finished(&finished_pages, &finished_page, &url, path.as_deref(), !failed.get());
                    }
                });
            });
        }
    }).map_err(|error| error.to_string())
}

pub async fn decide(view: Webview, pages: Pages, page_id: String, request_id: String, allow: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        view.with_webview(move |_| {
            let result = REQUESTS.with(|requests| {
                let pending = requests.borrow_mut().remove(&request_id).ok_or("권한 요청이 만료되었거나 이미 처리되었습니다.")?;
                let current = pages.lock().unwrap().get(&page_id).cloned();
                let valid = pending.page_id == page_id && pending.expires > now() && current.as_ref().is_some_and(|page| page.navigation_revision == pending.revision && page.control.owner == "human");
                finish_permission(&request_id, pending, if !valid { "expired" } else if allow { "allowed" } else { "denied" }, valid && allow);
                if valid { Ok(()) } else { Err("페이지나 제어권이 바뀌어 권한을 허용하지 않았습니다.") }
            });
            let _ = tx.send(result.map_err(str::to_string));
        }).map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "권한 결정 결과를 확인하지 못했습니다.".to_string())?
    }).await.map_err(|error| error.to_string())?
}

pub async fn cancel_download(view: Webview, pages: Pages, page_id: String, download_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        view.with_webview(move |_| {
            let result = (|| {
                let url = {
                    let pages = pages.lock().unwrap(); let page = pages.get(&page_id).ok_or("웹 탭을 찾을 수 없습니다.")?;
                    let entry = page.downloads.iter().find(|entry| entry["id"] == download_id && entry["status"] == "downloading").ok_or("진행 중인 다운로드가 아닙니다.")?;
                    entry["url"].as_str().ok_or("다운로드 주소를 확인할 수 없습니다.")?.to_string()
                };
                let download = DOWNLOADS.with(|downloads| downloads.borrow().get(&(page_id.clone(), url)).cloned()).ok_or("다운로드 핸들을 확인하지 못해 취소하지 않았습니다.")?;
                if let Some(page) = pages.lock().unwrap().get_mut(&page_id) {
                    if let Some(entry) = page.downloads.iter_mut().find(|entry| entry["id"] == download_id) { entry["status"] = json!("cancelled"); entry["finishedAt"] = json!(now()); }
                }
                download.cancel(); Ok(())
            })();
            let _ = tx.send(result.map_err(str::to_string));
        }).map_err(|error| error.to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "다운로드 취소 결과를 확인하지 못했습니다.".to_string())?
    }).await.map_err(|error| error.to_string())?
}

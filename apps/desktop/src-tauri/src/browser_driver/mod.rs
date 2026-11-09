//! Adapters to the existing Tauri/Wry platform callbacks; no second browser runtime.
use std::{collections::HashMap, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use serde_json::json;
use tauri::Webview;
#[cfg(target_os = "macos")]
use tauri::Manager;
use super::{Page, now};

#[cfg(target_os = "linux")]
mod webkitgtk;

pub fn new_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("operating system random source");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn permission_support() -> Vec<String> {
    #[cfg(target_os = "macos")]
    let kinds = ["microphone", "camera"];
    #[cfg(target_os = "linux")]
    let kinds = ["microphone", "camera", "camera-microphone", "display-capture", "geolocation", "notifications", "pointer-lock"];
    #[cfg(target_os = "windows")]
    let kinds = ["microphone", "camera", "geolocation", "notifications", "clipboard-read", "midi", "sensors", "local-fonts", "window-management", "automatic-downloads", "file-system-access", "autoplay"];
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let kinds: [&str; 0] = [];
    kinds.iter().map(|value| value.to_string()).collect()
}

#[cfg(target_os = "macos")]
pub fn persistent_mac_profile(app: &tauri::AppHandle, profile: &str) -> Result<Option<[u8; 16]>, String> {
    use std::io::{Read, Write};
    static SUPPORTED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    let supported = SUPPORTED.get_or_init(|| std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()
        .filter(|output| output.status.success()).and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok()).is_some_and(|major| major >= 14));
    if !supported { return Ok(None); }
    let directory = app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("browser-profiles").join(profile);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let file = directory.join("wk-store-id");
    if !file.exists() {
        let mut bytes = [0u8; 16]; getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
            Ok(mut output) => { output.write_all(&bytes).map_err(|error| error.to_string())?; output.sync_all().map_err(|error| error.to_string())?; },
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.to_string()),
        }
    }
    let mut bytes = [0u8; 16]; std::fs::File::open(file).and_then(|mut input| input.read_exact(&mut bytes)).map_err(|error| error.to_string())?;
    Ok(Some(bytes))
}

fn safe_name(path: &Path) -> String {
    let raw = path.file_name().and_then(|name| name.to_str()).unwrap_or("download");
    let name: String = raw.chars().filter(|character| !character.is_control()).map(|character| if "/\\:*?\"<>|".contains(character) { '_' } else { character }).take(140).collect();
    let name = name.trim_matches(|character: char| character == '.' || character.is_whitespace());
    if name.is_empty() { "download".into() } else { name.into() }
}

pub fn requested(pages: &Arc<Mutex<HashMap<String, Page>>>, page_id: &str, url: &str, destination: &mut PathBuf) -> bool {
    let mut pages = pages.lock().unwrap(); let Some(page) = pages.get_mut(page_id) else { return false; };
    let id = new_id(); let name = safe_name(destination);
    let mut error = None;
    if page.download_directory.is_none() { error = Some("저장 폴더를 고른 뒤 사이트의 다운로드 버튼을 다시 눌러 주세요."); }
    if page.downloads.iter().any(|entry| entry["url"] == url && (entry["status"] == "downloading" || entry["status"] == "unconfirmed")) { error = Some("같은 주소의 다운로드가 진행 중이거나 결과 확인이 필요합니다. 완료 후 다시 시도해 주세요."); }
    let path = page.download_directory.as_ref().map(|directory| {
        let name_path = Path::new(&name); let stem = name_path.file_stem().and_then(|value| value.to_str()).unwrap_or("download");
        let suffix = name_path.extension().and_then(|value| value.to_str()).map(|value| format!(".{value}")).unwrap_or_default();
        PathBuf::from(directory).join(format!("{stem}-{}{suffix}", &id[..12]))
    });
    if path.as_ref().is_some_and(|path| path.exists()) { error = Some("저장 파일 이름이 이미 사용 중입니다. 사이트에서 다시 시도해 주세요."); }
    if page.downloads.len() >= 100 { if let Some(index) = page.downloads.iter().position(|entry| entry["status"] != "downloading" && entry["status"] != "checking") { page.downloads.remove(index); } else { return false; } }
    let accepted = error.is_none();
    page.downloads.push(json!({"id":id,"url":url,"name":name,"path":path,"directory":page.download_directory,"requestedAt":now(),"finishedAt":if accepted {None} else {Some(now())},"status":if accepted {"downloading"} else {"blocked"},"size":null,"sha256":null,"error":error}));
    if accepted { *destination = path.unwrap(); }
    accepted
}

pub fn finished(pages: &Arc<Mutex<HashMap<String, Page>>>, page_id: &str, url: &str, path: Option<&Path>, success: bool) {
    let mut guard = pages.lock().unwrap(); let Some(page) = guard.get_mut(page_id) else { return; };
    let Some(index) = page.downloads.iter().position(|entry| entry["url"] == url && (entry["status"] == "downloading" || entry["status"] == "unconfirmed")) else { return; };
    // Windows/WK callbacks omit operation identity on failure. A blocked duplicate may finish too.
    let ambiguous = !success && path.is_none() && page.downloads.iter().skip(index + 1).any(|entry| entry["url"] == url && entry["status"] == "blocked");
    let entry = &mut page.downloads[index];
    if ambiguous { entry["status"] = json!("unconfirmed"); entry["error"] = json!("동일 주소의 요청 결과를 구분하지 못했습니다. 저장 폴더를 확인해 주세요. 완료 파일이 확인되기 전에는 보관하지 않습니다."); return; }
    let expected = entry["path"].as_str().map(PathBuf::from);
    // WKWebView's completed callback omits path. The accepted request's destination is authoritative.
    let same_path = path.is_none() || expected.as_deref() == path || expected.as_ref().and_then(|value| value.canonicalize().ok()).zip(path.and_then(|value| value.canonicalize().ok())).is_some_and(|(expected, actual)| expected == actual);
    let metadata = expected.as_ref().and_then(|path| std::fs::symlink_metadata(path).ok()).filter(|value| value.is_file() && !value.file_type().is_symlink());
    entry["finishedAt"] = json!(now());
    if success && same_path && metadata.is_some() {
        let metadata = metadata.unwrap(); entry["size"] = json!(metadata.len()); entry["error"] = json!(null);
        if metadata.len() > 25 * 1024 * 1024 { entry["status"] = json!("completed"); return; }
        entry["status"] = json!("checking");
        let download_id = entry["id"].as_str().unwrap_or("").to_string(); let page_id = page_id.to_string();
        let source = expected.unwrap(); let shared = pages.clone();
        // Hash outside the native callback so a saved file cannot stall the renderer.
        std::thread::spawn(move || {
            use sha2::{Digest, Sha256};
            let result = (|| -> Result<String, String> {
                use std::io::Read;
                let mut bytes = Vec::new();
                std::fs::File::open(&source).map_err(|error| error.to_string())?.take(25 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
                let after = std::fs::symlink_metadata(&source).map_err(|error| error.to_string())?;
                if after.file_type().is_symlink() || !after.is_file() || after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() || bytes.len() as u64 != metadata.len() { return Err("완료 파일이 확인 중 변경되었습니다.".into()); }
                Ok(format!("{:x}", Sha256::digest(&bytes)))
            })();
            if let Some(page) = shared.lock().unwrap().get_mut(&page_id) {
                if let Some(entry) = page.downloads.iter_mut().find(|entry| entry["id"] == download_id && entry["status"] == "checking") {
                    match result { Ok(hash) => { entry["sha256"] = json!(hash); entry["status"] = json!("completed"); }, Err(error) => { entry["status"] = json!("failed"); entry["error"] = json!(error); } }
                }
            }
        });
    } else { entry["status"] = json!("failed"); entry["error"] = json!("다운로드 완료 파일을 확인하지 못했습니다. 사이트에서 다시 시도해 주세요."); }
}

pub fn attach(view: &Webview, pages: Arc<Mutex<HashMap<String, Page>>>, page_id: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return webkitgtk::attach(view, pages, page_id);
    #[cfg(not(target_os = "linux"))]
    { let _ = (view, pages, page_id); Ok(()) }
}

pub fn invalidate(page_id: &str) {
    #[cfg(target_os = "linux")]
    webkitgtk::invalidate(page_id);
    #[cfg(not(target_os = "linux"))]
    let _ = page_id;
}

pub fn detach(view: &Webview, page_id: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    { let page_id = page_id.to_string(); return view.with_webview(move |_| webkitgtk::detach(&page_id)).map_err(|error| error.to_string()); }
    #[cfg(not(target_os = "linux"))]
    { let _ = (view, page_id); Ok(()) }
}

pub async fn decide(view: Webview, pages: Arc<Mutex<HashMap<String, Page>>>, page_id: String, request_id: String, allow: bool) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return webkitgtk::decide(view, pages, page_id, request_id, allow).await;
    #[cfg(not(target_os = "linux"))]
    { let _ = (view, pages, page_id, request_id, allow); Err("이 환경에서는 브라우저의 권한 확인창에서 결정해 주세요.".into()) }
}

pub async fn cancel_download(view: Webview, pages: Arc<Mutex<HashMap<String, Page>>>, page_id: String, download_id: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return webkitgtk::cancel_download(view, pages, page_id, download_id).await;
    #[cfg(not(target_os = "linux"))]
    { let _ = (view, pages, page_id, download_id); Err("이 환경의 현재 브라우저 API는 진행 중 다운로드 취소를 지원하지 않습니다.".into()) }
}

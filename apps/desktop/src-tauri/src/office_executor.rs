//! Host-owned Office execution process. No gateway, tray, plugins, or shell commands.
//! The boot capability stays in the environment/URL fragment, never in argv or diagnostics.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

const LABEL: &str = "office-executor";
const PARENT_PATH: &str = "/office/executor.html";
const BOOT_ENV: &str = "WORKBENCH_OFFICE_EXECUTOR_URL";

fn boot_url() -> Result<Url, ()> {
    let raw = std::env::var(BOOT_ENV).map_err(|_| ())?;
    // This entry runs before Tauri or any worker threads; children must not inherit it.
    std::env::remove_var(BOOT_ENV);
    let url = Url::parse(&raw).map_err(|_| ())?;
    let address = raw.strip_prefix("http://127.0.0.1:").and_then(|rest| rest.split_once('/'));
    let explicit_port = address.and_then(|(port, _)| port.parse::<u16>().ok()).is_some_and(|port| port != 0);
    let exact_path = address.is_some_and(|(_, rest)| rest.split_once('#').is_some_and(|(path, _)| path == "office/executor.html"));
    if !explicit_port || !exact_path
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port_or_known_default().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != PARENT_PATH
        || url.query().is_some()
        || url.fragment().is_none_or(|token| token.is_empty() || token.len() > 8192)
    {
        return Err(());
    }
    Ok(url)
}

fn same_origin(parent: &Url, url: &Url) -> bool {
    url.origin() == parent.origin() && url.username().is_empty() && url.password().is_none()
}

fn is_parent(parent: &Url, url: &Url) -> bool {
    same_origin(parent, url) && url.path() == PARENT_PATH && url.query().is_none()
}

fn navigation_allowed(parent: &Url, url: &Url) -> bool {
    // WebView2 calls this for top-level navigation only. WebKit also reports iframe
    // navigation, so its same-origin Office frames need to pass this first filter.
    #[cfg(windows)]
    { is_parent(parent, url) }
    #[cfg(not(windows))]
    {
        url.as_str() == "about:blank" || url.as_str() == "about:srcdoc"
            || (same_origin(parent, url) && url.path().starts_with("/office/"))
    }
}

fn finish(app: &tauri::AppHandle, finished: &AtomicBool, code: i32) {
    if !finished.swap(true, Ordering::SeqCst) { app.exit(code); }
}

fn watch_owner(app: tauri::AppHandle, finished: Arc<AtomicBool>) {
    // Only the host which spawned this process owns this pipe. EOF is a normal
    // stop even when JS is unresponsive; no PID discovery or process adoption.
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut buffer = [0_u8; 64];
        let mut matched = 0_usize;
        let mut other = false;
        loop {
            let size = match input.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => size,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            for byte in &buffer[..size] {
                if *byte == b'\n' {
                    if !other && matched == 4 { finish(&app, &finished, 3); return; }
                    matched = 0; other = false;
                } else if *byte != b'\r' {
                    if !other && b"stop".get(matched) == Some(byte) { matched += 1; }
                    else { other = true; }
                }
            }
        }
        finish(&app, &finished, 3);
    });
}

#[cfg(target_os = "linux")]
fn restrict_main_response(window: &tauri::WebviewWindow, parent: Url) -> tauri::Result<()> {
    use gtk::prelude::Cast;
    use webkit2gtk::{PolicyDecisionExt, PolicyDecisionType, ResponsePolicyDecision, ResponsePolicyDecisionExt, URIRequestExt, WebViewExt};
    window.with_webview(move |platform| {
        platform.inner().connect_decide_policy(move |_, decision, kind| {
            if kind != PolicyDecisionType::Response { return false; }
            let Some(response) = decision.dynamic_cast_ref::<ResponsePolicyDecision>() else { return false; };
            if !response.is_main_frame_main_resource() { return false; }
            let permitted = response.request().and_then(|request| request.uri())
                .and_then(|uri| Url::parse(uri.as_str()).ok())
                .is_some_and(|url| is_parent(&parent, &url));
            if permitted { return false; }
            // Refuse replacement of the executor parent before the document commits.
            decision.ignore();
            true
        });
    })
}

pub fn run() -> i32 {
    if std::env::args_os().count() != 2 {
        eprintln!("Office executor accepts no command-line payload.");
        return 2;
    }
    let parent = match boot_url() {
        Ok(url) => url,
        Err(()) => { eprintln!("Office executor boot configuration is invalid."); return 2; }
    };
    let profile = match tempfile::Builder::new().prefix("workbench-office-executor-").tempdir() {
        Ok(profile) => profile,
        Err(_) => { eprintln!("Office executor storage could not be prepared."); return 1; }
    };
    let data_dir = profile.path().join("webview");
    let finished = Arc::new(AtomicBool::new(false));
    let closed = finished.clone();
    let app = tauri::Builder::default()
        // The distinct label has no capability grant. Deliberately install no
        // invoke handler or plugins: even the parent receives no OS command API.
        .on_window_event(move |window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
                finish(window.app_handle(), &closed, 3);
            }
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.handle().set_activation_policy(tauri::ActivationPolicy::Accessory)?;
            let navigation = parent.clone();
            let loaded_parent = parent.clone();
            let title_parent = parent.clone();
            let title_finished = finished.clone();
            let load_finished = finished.clone();
            let parent_seen = AtomicBool::new(false);
            let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(parent.clone()))
                .title("Office executor")
                .inner_size(1280.0, 860.0)
                .visible(false).focused(false).skip_taskbar(true)
                .incognito(true).data_directory(data_dir)
                .devtools(false)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .disable_drag_drop_handler()
                .on_navigation(move |url| navigation_allowed(&navigation, url))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
                .on_page_load(move |window, event| {
                    if is_parent(&loaded_parent, event.url()) {
                        parent_seen.store(true, Ordering::SeqCst);
                    } else if event.url().as_str() != "about:blank" || parent_seen.load(Ordering::SeqCst) {
                        finish(window.app_handle(), &load_finished, 1);
                    }
                })
                .on_document_title_changed(move |window, title| {
                    let code = match title.as_str() {
                        "workbench-office-executor:finished" => 0,
                        "workbench-office-executor:interrupted" => 3,
                        "workbench-office-executor:failed" => 1,
                        _ => return,
                    };
                    if window.url().ok().is_some_and(|url| is_parent(&title_parent, &url)) {
                        // Exit status is process lifecycle only. The host's durable
                        // receipt decides whether the admitted document job succeeded.
                        finish(window.app_handle(), &title_finished, code);
                    }
                })
                .build()?;
            #[cfg(target_os = "linux")]
            restrict_main_response(&window, parent)?;
            #[cfg(not(target_os = "linux"))]
            let _ = window;
            watch_owner(app.handle().clone(), finished);
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(_) => { eprintln!("Office executor could not start."); return 1; }
    };
    let code = app.run_return(|_, _| {});
    drop(profile);
    code
}

//! Executes the production shared-browser implementation in an isolated native Tauri window.
//! This checks the native driver; it is not an installed Workbench UI acceptance test.
use serde_json::{json, Value};
use std::{path::PathBuf, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{Manager, Webview};

#[path = "../src/shared_browser.rs"]
mod shared_browser;

// shared_browser's internal-origin guard optionally looks up this production state type.
#[allow(dead_code)]
struct Ready { url: String }

fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64 }

async fn eval(view: &Webview, expression: &str) -> Result<Value, String> {
    let view = view.clone();
    let expression = expression.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        view.eval_with_callback(expression, move |raw| { let _ = tx.send(raw); }).map_err(|error| error.to_string())?;
        let raw = rx.recv_timeout(Duration::from_secs(10)).map_err(|error| error.to_string())?;
        serde_json::from_str(&raw).map_err(|error| format!("eval JSON: {error}; {raw}"))
    }).await.map_err(|error| error.to_string())?
}

async fn command(app: &tauri::AppHandle, caller: &Webview, input: Value) -> Result<Value, String> {
    shared_browser::shared_browser(app.clone(), caller.clone(), input).await
}

async fn execute(app: &tauri::AppHandle, caller: &Webview, page: &str, name: &str, action: Value, control: &Value, expected: Value) -> Result<Value, String> {
    let result = command(app, caller, json!({"kind":"execute","job":{
        "id":name,"pageId":page,"action":action,"control":control,"expected":expected,"deadline":now()+20000
    }})).await?;
    if let Some(error) = result["error"].as_str() { return Err(format!("{name}: {error}")); }
    Ok(result)
}

// Only read-only readiness checks are polled. Mutating commands above are never replayed.
async fn wait_document(view: &Webview, url: &str) -> Result<Value, String> {
    let expression = format!("(()=>({{url:location.href,ready:document.readyState==='complete' && !!window.__ACHMAGE_PAGE__ && [...document.querySelectorAll('iframe')].every(f=>f.contentDocument?.readyState==='complete'),expected:location.href==={}}}))()", json!(url));
    let mut last = Value::Null;
    for _ in 0..80 {
        match eval(view, &expression).await {
            Ok(value) => {
                if value["ready"] == true && value["expected"] == true { return Ok(value); }
                last = value;
            }
            Err(error) => { last = json!({"evaluationError":error}); }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("Document did not become ready: {last}"))
}

async fn geometry(view: &Webview) -> Result<Value, String> {
    eval(view, "({width:innerWidth,height:innerHeight,url:location.href})").await
}

fn check(checks: &mut Vec<Value>, name: &str, passed: bool, details: Value) -> Result<(), String> {
    checks.push(json!({"name":name,"passed":passed,"details":details}));
    if passed { Ok(()) } else { Err(format!("Assertion failed: {name}")) }
}

async fn native_bounds(view: &Webview) -> Result<Value, String> {
    let view = view.clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "linux")]
        {
            let (tx, rx) = std::sync::mpsc::channel();
            view.with_webview(move |native| {
                use gtk::prelude::WidgetExt;
                let bounds = native.inner().allocation();
                let _ = tx.send(json!({"x":bounds.x(),"y":bounds.y(),"width":bounds.width(),"height":bounds.height()}));
            }).map_err(|error| error.to_string())?;
            rx.recv_timeout(Duration::from_secs(5)).map_err(|error| error.to_string())
        }
        #[cfg(not(target_os = "linux"))]
        {
            let factor = view.window().scale_factor().map_err(|error| error.to_string())?;
            let bounds = view.bounds().map_err(|error| error.to_string())?;
            let origin = bounds.position.to_logical::<f64>(factor);
            let size = bounds.size.to_logical::<f64>(factor);
            Ok(json!({"x":origin.x,"y":origin.y,"width":size.width,"height":size.height}))
        }
    }).await.map_err(|error| error.to_string())?
}

async fn assert_geometry(checks: &mut Vec<Value>, main: &Webview, page: &Webview, baseline: &Value, x: f64, y: f64, width: i64, height: i64, name: &str) -> Result<(), String> {
    // A GTK resize and the web process resize notification are asynchronous.
    let mut actual = Value::Null;
    for _ in 0..40 {
        actual = geometry(page).await?;
        if actual["width"].as_i64() == Some(width) && actual["height"].as_i64() == Some(height) { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let shell = geometry(main).await?;
    let bounds = native_bounds(page).await?;
    let within = |key: &str, expected: f64| bounds[key].as_f64().is_some_and(|actual| (actual - expected).abs() <= 2.0);
    check(checks, name, within("x", x) && within("y", y) && within("width", width as f64) && within("height", height as f64) && actual["width"].as_i64() == Some(width) && actual["height"].as_i64() == Some(height) && shell["width"] == baseline["width"] && shell["height"] == baseline["height"], json!({"page":actual,"nativeBounds":bounds,"requested":{"x":x,"y":y,"width":width,"height":height},"main":shell,"mainBefore":baseline}))
}

async fn run(app: &tauri::AppHandle, base: &str, isolation: &PathBuf, checks: &mut Vec<Value>) -> Result<(), String> {
    let caller = app.get_webview("main").ok_or("Main webview missing")?;
    let data = app.path().app_local_data_dir().map_err(|error| error.to_string())?;
    let resolved = data.canonicalize().map_err(|error| error.to_string())?;
    let root = isolation.canonicalize().map_err(|error| error.to_string())?;
    check(checks, "profile-isolation", resolved.starts_with(&root), json!({"appData":data,"resolved":resolved,"temporaryRoot":root}))?;
    tokio::time::sleep(Duration::from_millis(400)).await;
    let baseline = geometry(&caller).await?;
    check(checks, "main-viewport-ready", baseline["width"].as_i64().unwrap_or(0) >= 900 && baseline["height"].as_i64().unwrap_or(0) >= 600, baseline.clone())?;
    let human = json!({"owner":"human","generation":0});
    let ai = json!({"owner":"check-session","generation":1});
    command(app, &caller, json!({"kind":"create","pageId":"check-a","profileId":"profile-a","url":"about:blank","control":human})).await?;
    let a = app.get_webview("wb-page-check-a").ok_or("First page missing")?;
    wait_document(&a, "about:blank").await?;
    command(app, &caller, json!({"kind":"present","pages":[{"pageId":"check-a","x":24,"y":80,"width":600,"height":500,"visible":true}]})).await?;
    assert_geometry(checks, &caller, &a, &baseline, 24.0, 80.0, 600, 500, "blank-present-bounds-and-main-preserved").await?;

    let target = format!("{base}/page-a");
    execute(app, &caller, "check-a", "navigate-a", json!({"kind":"navigate","url":target}), &human, Value::Null).await?;
    wait_document(&a, &target).await?;
    let snapshot = execute(app, &caller, "check-a", "snapshot-a-human", json!({"kind":"snapshot"}), &human, Value::Null).await?;
    check(checks, "top-frame-url-not-iframe", snapshot["page"]["url"] == target && snapshot["observation"]["text"].as_str().unwrap_or("").contains(&format!("URL: {target}\n")), snapshot["page"].clone())?;
    execute(app, &caller, "check-a", "grant-a", json!({"kind":"control","control":ai}), &ai, Value::Null).await?;
    let snapshot = execute(app, &caller, "check-a", "snapshot-a-ai", json!({"kind":"snapshot"}), &ai, Value::Null).await?;
    let text = snapshot["observation"]["text"].as_str().ok_or("Missing snapshot text")?;
    let line = text.lines().find(|line| line.contains("native-search" ) && line.starts_with('[')).ok_or("Search input missing from native snapshot")?;
    let reference = line.split(']').next().ok_or("Missing search reference")?.trim_start_matches('[');
    execute(app, &caller, "check-a", "fill-a", json!({"kind":"fill","ref":reference,"value":"new york times"}), &ai, snapshot["observation"].clone()).await?;
    let actual = eval(&a, "({value:document.querySelector('#search').value,url:location.href,inputEvents:window.inputEvents||0})").await?;
    check(checks, "real-native-input-filled", actual["value"] == "new york times" && actual["url"] == target && actual["inputEvents"].as_i64().unwrap_or(0) > 0, actual)?;

    let b_url = format!("{base}/page-b");
    command(app, &caller, json!({"kind":"create","pageId":"check-b","profileId":"profile-b","url":b_url,"control":human})).await?;
    let b = app.get_webview("wb-page-check-b").ok_or("Second page missing")?;
    wait_document(&b, &b_url).await?;
    command(app, &caller, json!({"kind":"present","pages":[{"pageId":"check-b","x":70,"y":110,"width":480,"height":360,"visible":true}]})).await?;
    assert_geometry(checks, &caller, &b, &baseline, 70.0, 110.0, 480, 360, "second-tab-bounds-and-main-preserved").await?;
    let hidden = execute(app, &caller, "check-a", "snapshot-a-hidden", json!({"kind":"snapshot"}), &ai, Value::Null).await?;
    check(checks, "hidden-tab-keeps-target-and-value", hidden["observation"]["target"]["pageId"] == "check-a" && hidden["observation"]["text"].as_str().unwrap_or("").contains("new york times"), hidden["observation"].clone())?;
    command(app, &caller, json!({"kind":"present","pages":[]})).await?;
    command(app, &caller, json!({"kind":"present","pages":[{"pageId":"check-a","x":30,"y":90,"width":620,"height":440,"visible":true}]})).await?;
    assert_geometry(checks, &caller, &a, &baseline, 30.0, 90.0, 620, 440, "restored-tab-resized-and-main-preserved").await?;
    let restored = execute(app, &caller, "check-a", "snapshot-a-restored", json!({"kind":"snapshot"}), &ai, Value::Null).await?;
    let retained = eval(&a, "({value:document.querySelector('#search').value,url:location.href})").await?;
    check(checks, "restored-tab-keeps-document-control-and-dom", restored["observation"]["documentNonce"] == snapshot["observation"]["documentNonce"] && restored["page"]["control"] == ai && retained["value"] == "new york times" && retained["url"] == target, json!({"observation":restored["observation"],"actual":retained}))?;
    let untouched = eval(&b, "({value:document.querySelector('#search').value,url:location.href})").await?;
    check(checks, "separate-page-not-mutated", untouched["value"] == "" && untouched["url"] == b_url, untouched)?;
    Ok(())
}

fn main() {
    let base = std::env::var("BROWSER_CHECK_BASE_URL").expect("BROWSER_CHECK_BASE_URL required");
    let report = PathBuf::from(std::env::var_os("BROWSER_CHECK_REPORT").expect("BROWSER_CHECK_REPORT required"));
    let isolation = PathBuf::from(std::env::var_os("BROWSER_CHECK_PROFILE_ROOT").expect("BROWSER_CHECK_PROFILE_ROOT required"));
    let identifier = std::env::var("BROWSER_CHECK_IDENTIFIER").expect("BROWSER_CHECK_IDENTIFIER required");
    assert!(identifier.starts_with("kr.achmage.browsercheck.") && identifier.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'.'));
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = identifier;
    context.config_mut().product_name = Some("Shared browser native check".into());
    tauri::Builder::default()
        .manage(shared_browser::SharedBrowser::default())
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(format!("{base}/shell").parse()?))
                .title("Shared browser native check")
                .inner_size(1000.0, 720.0)
                .incognito(true)
                .build()?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut checks = Vec::new();
                let result = run(&app, &base, &isolation, &mut checks).await;
                let ok = result.is_ok();
                let output = json!({"scope":"production native shared_browser.rs standalone harness; not installed Workbench UI","os":std::env::consts::OS,"ok":ok,"checks":checks,"error":result.err()});
                let write = std::fs::write(&report, serde_json::to_vec_pretty(&output).unwrap());
                println!("{output}");
                app.exit(if ok && write.is_ok() { 0 } else { 1 });
            });
            Ok(())
        })
        .run(context)
        .expect("Could not run native shared browser check");
}

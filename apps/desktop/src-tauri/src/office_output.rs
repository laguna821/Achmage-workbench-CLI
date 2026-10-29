//! Shared vector output for embedded editors. No document paths, URLs or scripts are loaded.
//! Paper snapping follows IeumOffice hwp/src/main/print-document.ts @ 30ff4f051f067fcb2baf1ab416c40718c802ca35
//! (Apache-2.0; third_party/ieumoffice/NOTICE). PDF composition uses svg2pdf/pdf-writer.
use std::collections::HashMap;
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock};
use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref};
use serde::Deserialize;
use svg2pdf::usvg;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const MAX_BYTES: usize = 64_000_000;
const MAX_PAGES: usize = 2_000;
static OUTPUT_LOCK: Mutex<()> = Mutex::new(());
static NEXT_PRINT: AtomicU64 = AtomicU64::new(1);
static FONTS: OnceLock<std::sync::Arc<usvg::fontdb::Database>> = OnceLock::new();

#[derive(Deserialize)]
pub struct SvgPage { svg: String, width: f32, height: f32 }
#[derive(Deserialize)]
pub struct SvgJob { pages: Vec<SvgPage>, #[serde(default)] images: Vec<String> }
#[derive(Default)]
pub struct PrintJobs(pub Mutex<HashMap<String, String>>);

fn side_mm(px: f32) -> f32 {
    let mm = px * 25.4 / 96.0;
    [148.0, 182.0, 210.0, 215.9, 257.0, 279.4, 297.0, 355.6, 364.0, 420.0, 431.8]
        .into_iter().find(|paper| (paper - mm).abs() <= 0.05).unwrap_or(mm)
}

fn validate_svg(svg: &str) -> Result<(), String> {
    let xml = roxmltree::Document::parse(svg).map_err(|e| format!("SVG를 읽지 못했습니다: {e}"))?;
    if xml.root_element().tag_name().name() != "svg" { return Err("SVG 페이지가 아닙니다.".into()); }
    for node in xml.descendants().filter(|n| n.is_element()) {
        if matches!(node.tag_name().name(), "script" | "foreignObject" | "iframe" | "audio" | "video") {
            return Err("출력 페이지에 실행 가능한 내용이 있습니다.".into());
        }
        for attr in node.attributes() {
            if attr.name().starts_with("on") { return Err("출력 페이지에 이벤트 코드가 있습니다.".into()); }
            if attr.name() == "href" && !attr.value().starts_with('#') && !attr.value().starts_with("data:image/") {
                return Err("출력 페이지의 외부 파일 참조를 허용하지 않습니다.".into());
            }
        }
    }
    Ok(())
}

fn trees(job: &SvgJob) -> Result<Vec<usvg::Tree>, String> {
    if job.pages.is_empty() || job.pages.len() > MAX_PAGES { return Err("출력할 쪽 수가 올바르지 않습니다.".into()); }
    let total = job.pages.iter().map(|p| p.svg.len()).chain(job.images.iter().map(String::len)).sum::<usize>();
    if total > MAX_BYTES { return Err("출력 페이지가 너무 큽니다 (최대 64 MB).".into()); }
    for image in &job.images {
        if !image.starts_with("data:image/") || image.contains(['"', '<', '>']) {
            return Err("출력 그림 데이터가 올바르지 않습니다.".into());
        }
    }
    let mut options = usvg::Options::default();
    options.fontdb = FONTS.get_or_init(|| {
        let mut fonts = usvg::fontdb::Database::new(); fonts.load_system_fonts(); std::sync::Arc::new(fonts)
    }).clone();
    // The default usvg resolver accepts local paths. All images must be embedded in this job.
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    options.resources_dir = None;
    let mut expanded_bytes = 0usize;
    job.pages.iter().map(|page| {
        if !page.width.is_finite() || !page.height.is_finite() || page.width <= 0.0 || page.height <= 0.0 || page.width > 20_000.0 || page.height > 20_000.0 {
            return Err("출력 용지 크기가 올바르지 않습니다.".into());
        }
        let mut svg = page.svg.clone();
        for (index, image) in job.images.iter().enumerate() {
            svg = svg.replace(&format!("href=\"ieum-image:{index}\""), &format!("href=\"{image}\""));
        }
        expanded_bytes = expanded_bytes.saturating_add(svg.len());
        if expanded_bytes > MAX_BYTES * 4 { return Err("반복 그림을 포함한 출력 데이터가 너무 큽니다.".into()); }
        validate_svg(&svg)?;
        let tree = usvg::Tree::from_str(&svg, &options).map_err(|e| format!("출력 페이지를 읽지 못했습니다: {e}"))?;
        if (tree.size().width() - page.width).abs() > 1.0 || (tree.size().height() - page.height).abs() > 1.0 {
            return Err("SVG와 용지의 크기가 일치하지 않습니다.".into());
        }
        Ok(tree)
    }).collect()
}

pub fn pdf_bytes(job: &SvgJob) -> Result<Vec<u8>, String> {
    let trees = trees(job)?;
    let mut alloc = Ref::new(1);
    let catalog = alloc.bump(); let root = alloc.bump();
    let page_ids: Vec<_> = trees.iter().map(|_| alloc.bump()).collect();
    let mut pdf = Pdf::new();
    pdf.catalog(catalog).pages(root);
    pdf.pages(root).kids(page_ids.iter().copied()).count(page_ids.len() as i32);
    for (index, tree) in trees.iter().enumerate() {
        let (chunk, svg_id) = svg2pdf::to_chunk(tree, svg2pdf::ConversionOptions { pdfa: true, ..Default::default() })
            .map_err(|e| format!("PDF를 만들지 못했습니다: {e}"))?;
        let mut refs = HashMap::new();
        let chunk = chunk.renumber(|old| *refs.entry(old).or_insert_with(|| alloc.bump()));
        let content_id = alloc.bump();
        let width = side_mm(job.pages[index].width) * 72.0 / 25.4;
        let height = side_mm(job.pages[index].height) * 72.0 / 25.4;
        let mut page = pdf.page(page_ids[index]);
        page.parent(root).media_box(Rect::new(0.0, 0.0, width, height)).contents(content_id);
        page.resources().x_objects().pair(Name(b"Page"), refs[&svg_id]);
        page.finish();
        let mut content = Content::new();
        // Paper stays white even if an editor omitted its background rectangle.
        content.set_fill_rgb(1.0, 1.0, 1.0).rect(0.0, 0.0, width, height).fill_nonzero();
        content.transform([width, 0.0, 0.0, height, 0.0, 0.0]).x_object(Name(b"Page"));
        pdf.stream(content_id, &content.finish()); pdf.extend(&chunk);
    }
    Ok(pdf.finish())
}

#[tauri::command]
pub async fn render_svg_pdf(job: SvgJob) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = OUTPUT_LOCK.try_lock().map_err(|_| "다른 문서를 출력 중입니다. 잠시 뒤 다시 시도하세요.".to_string())?;
        pdf_bytes(&job).map(tauri::ipc::Response::new)
    }).await.map_err(|e| e.to_string())?
}

fn print_html(job: &SvgJob) -> Result<String, String> {
    let trees = trees(job)?;
    let mut styles = String::from("*{margin:0;padding:0}body{background:#ddd}.page{background:white;overflow:hidden;break-after:page;margin:12px auto}.page:last-child{break-after:auto}.page>svg{display:block;width:100%;height:100%}@media print{body{background:white}.page{margin:0}}");
    let mut body = String::new();
    for (i, tree) in trees.iter().enumerate() {
        let (w, h) = (side_mm(job.pages[i].width), side_mm(job.pages[i].height));
        styles.push_str(&format!("@page p{i}{{size:{w}mm {h}mm;margin:0}}.p{i}{{page:p{i};width:{w}mm;height:{h}mm}}"));
        // usvg serializes a static tree, with text converted to the resolved font outlines.
        // Per-page IDs are made unique by the serializer.
        let svg = tree.to_string(&usvg::WriteOptions { id_prefix: Some(format!("p{i}-")), ..Default::default() });
        body.push_str(&format!("<div class=\"page p{i}\">{svg}</div>"));
    }
    Ok(format!("<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\"><style>{styles}</style><body>{body}</body>"))
}

#[tauri::command]
pub async fn print_svg(app: tauri::AppHandle, job: SvgJob) -> Result<(), String> {
    let html = tauri::async_runtime::spawn_blocking(move || {
        let _guard = OUTPUT_LOCK.try_lock().map_err(|_| "다른 문서를 출력 중입니다.".to_string())?;
        print_html(&job)
    }).await.map_err(|e| e.to_string())??;
    let id = format!("print-{}", NEXT_PRINT.fetch_add(1, Ordering::Relaxed));
    {
        let state = app.state::<PrintJobs>(); let mut jobs = state.0.lock().map_err(|e| e.to_string())?;
        if jobs.len() >= 4 { return Err("먼저 열린 인쇄 창을 닫아 주세요.".into()); }
        jobs.insert(id.clone(), html);
    }
    use tauri::menu::{Menu, MenuItem, Submenu};
    let print = MenuItem::with_id(&app, "print", "인쇄…", true, Some("CmdOrCtrl+P")).map_err(|e| e.to_string())?;
    let close = MenuItem::with_id(&app, "close", "닫기", true, Some("CmdOrCtrl+W")).map_err(|e| e.to_string())?;
    let file = Submenu::with_items(&app, "파일", true, &[&print, &close]).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&file]).map_err(|e| e.to_string())?;
    let result = WebviewWindowBuilder::new(&app, &id, WebviewUrl::External(format!("workbench-print://localhost/{id}").parse().unwrap()))
        .title("인쇄 미리보기 — Achmage Workbench").inner_size(900.0, 900.0).menu(menu)
        .on_menu_event(|window, event| {
            if event.id.as_ref() == "print" {
                if let Some(view) = window.app_handle().get_webview_window(window.label()) {
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = view.print() { eprintln!("[office-output] print: {error}"); }
                    });
                }
            } else if event.id.as_ref() == "close" { let _ = window.close(); }
        })
        .on_page_load(|webview, payload| {
            #[cfg(debug_assertions)]
            eprintln!("[office-output] {} page {:?}", webview.label(), payload.event());
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                // Dispatch after the WebKit load callback returns. Printing enters a native
                // modal loop; calling it synchronously here re-enters the webview runtime.
                let view = webview.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = view.print() { eprintln!("[office-output] print: {error}"); }
                });
            }
        })
        .build();
    if let Err(error) = result { app.state::<PrintJobs>().0.lock().unwrap().remove(&id); return Err(error.to_string()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn page(width: f32, height: f32, content: &str) -> SvgPage { SvgPage { width, height, svg: format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\">{content}</svg>") } }
    #[test]
    fn pdf_pages_and_print_share_dimensions_and_vectors() {
        let job = SvgJob { pages: vec![page(793.7, 1122.5, "<rect x=\"10\" y=\"10\" width=\"80\" height=\"40\" fill=\"red\"/>"), page(1122.5, 793.7, "<circle cx=\"100\" cy=\"100\" r=\"50\"/>")], images: vec![] };
        let bytes = pdf_bytes(&job).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-1.7")); assert!(text.contains("/Count 2"));
        assert!(text.contains("/Subtype /Form")); assert!(!text.contains("/Subtype /Image"));
        let html = print_html(&job).unwrap(); assert!(html.contains("size:210mm 297mm")); assert!(html.contains("size:297mm 210mm"));
        if let Some(path) = std::env::var_os("WORKBENCH_PDF_TEST_OUTPUT") { std::fs::write(path, bytes).unwrap(); }
    }
    #[test]
    fn external_or_executable_content_cannot_reach_output() {
        for content in ["<image href=\"file:///etc/passwd\"/>", "<image href=\"https://example.com/x.png\"/>", "<script>alert(1)</script>", "<rect onclick=\"alert(1)\"/>", "<foreignObject/>"] {
            let job = SvgJob { pages: vec![page(100.0, 100.0, content)], images: vec![] }; assert!(pdf_bytes(&job).is_err()); assert!(print_html(&job).is_err());
        }
        assert!(pdf_bytes(&SvgJob { pages: vec![], images: vec![] }).is_err());
    }
}

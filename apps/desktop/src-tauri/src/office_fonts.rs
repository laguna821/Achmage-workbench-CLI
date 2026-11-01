//! Font enumeration adapted from Achmage HOP font_catalog.rs @ d533eb4360db034cd45d87b0751c0d742c6d6ca6.
//! MIT; third_party/hop/LICENSE. OS-installed fonts only; no font files are installed or bundled.
use serde::Serialize;
use std::collections::BTreeSet;
use svg2pdf::usvg::fontdb::{Database, Source, Style};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFontEntry {
    family: String,
    post_script_name: String,
    style: &'static str,
    weight: u16,
    source_kind: &'static str,
    path: String,
    face_index: u32,
}

/// A short-lived helper for the gateway. Paths never cross the document's HTTP boundary.
pub fn run() -> i32 {
    let mut db = Database::new();
    db.load_system_fonts();
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        db.load_fonts_dir(std::path::PathBuf::from(local).join("Microsoft/Windows/Fonts"));
    }
    let mut seen = BTreeSet::new();
    let mut entries = Vec::new();
    for face in db.faces() {
        let path = match &face.source {
            Source::File(path) | Source::SharedFile(path, _) => path.to_string_lossy().into_owned(),
            Source::Binary(_) => continue,
        };
        let style = match face.style { Style::Normal => "normal", Style::Italic => "italic", Style::Oblique => "oblique" };
        for (family, _) in &face.families {
            let family = family.trim();
            if family.is_empty() || !seen.insert((family.to_owned(), path.clone(), face.index)) { continue; }
            entries.push(LocalFontEntry {
                family: family.to_owned(), post_script_name: face.post_script_name.clone(), style,
                // Some installed fonts (macOS Apple Chancery) report usWeightClass=0.
                // CSS FontFace expects 1..=1000; absent/invalid metadata means Regular.
                weight: if (1..=1000).contains(&face.weight.0) { face.weight.0 } else { 400 },
                source_kind: "system-installed", path: path.clone(), face_index: face.index,
            });
        }
    }
    entries.sort_by(|a, b| a.family.cmp(&b.family).then(a.weight.cmp(&b.weight)).then(a.style.cmp(b.style)).then(a.path.cmp(&b.path)).then(a.face_index.cmp(&b.face_index)));
    match serde_json::to_writer(std::io::stdout().lock(), &entries) {
        Ok(()) => 0,
        Err(error) => { eprintln!("글꼴 목록을 읽지 못했습니다: {error}"); 1 }
    }
}

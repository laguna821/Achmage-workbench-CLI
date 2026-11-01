//! Adapter regressions, separate from the unmodified upstream test suite.
use ff10k_core::{Engine, SearchOptions};
use ff10k_core::doc::{DocumentFields, Doc};
use ff10k_core::rank::{Selection, Candidate};

#[test]
fn typed_metadata_survives_preview_and_is_removed_on_replacement() {
    let mut engine = Engine::new();
    let raw = "---\n\"DIKM_단계:\": [\"🔵 I\"]\n\"빈값:\":\n---\n원문 📝 body\n";
    let fields = DocumentFields { title: Some("Readable project".into()), aliases: Some(vec!["oldalias".into()]), ..Default::default() };
    engine.upsert_with_fields("opaque-123.md", 1.0, raw, fields);
    assert_eq!(engine.search("Readable", &SearchOptions::default()).hits.len(), 1);
    assert_eq!(engine.search("opaque", &SearchOptions::default()).hits.len(), 0);
    assert_eq!(engine.doc_text("opaque-123.md"), Some(raw));
    engine.upsert_with_fields("opaque-123.md", 2.0, raw,
        DocumentFields { title: Some("Replacement".into()), aliases: Some(vec!["newalias".into()]), ..Default::default() });
    assert!(engine.search("Readable", &SearchOptions::default()).hits.is_empty());
    assert!(engine.search("oldalias", &SearchOptions::default()).hits.is_empty());
    assert_eq!(engine.search("newalias", &SearchOptions::default()).hits.len(), 1);
    assert!(engine.remove("opaque-123.md"));
    engine.upsert("reused.md", 3.0, "fresh");
    assert!(engine.search("newalias", &SearchOptions::default()).hits.is_empty());
}

#[test]
fn scope_before_top_n_and_partial_cut_and_page_details() {
    let mut engine = Engine::new();
    for n in 0..75 { engine.upsert(&format!("blocked/alpha beta {n}.md"), n as f64, "alpha beta"); }
    engine.upsert("allowed/alpha delta.md", 1.0, "body");
    let allow = |doc: &Doc| doc.path.starts_with("allowed/");
    let mut choose = |c: &[Candidate<'_>]| { assert_eq!(c.len(), 1); vec![0] };
    let result = engine.search_selected("alpha beta", &SearchOptions { limit: 1, ..Default::default() }, &mut Selection { allow: &allow, choose: &mut choose });
    assert_eq!(result.total_docs, 1);
    assert_eq!(result.candidates, 1);
    assert_eq!(result.hits.len(), 1);
    assert_eq!(result.hits[0].tier, 4);
    assert_eq!(result.hits[0].path, "allowed/alpha delta.md");
}

#[test]
fn selected_recent_respects_offset_beyond_upstreams_twenty() {
    let mut engine = Engine::new();
    for n in 0..50 { engine.upsert(&format!("recent-{n}.md"), n as f64, "body"); }
    let allow = |_: &Doc| true;
    let mut choose = |c: &[Candidate<'_>]| { assert_eq!(c.len(), 50); vec![35, 36] };
    let result = engine.search_selected("", &SearchOptions { limit: 2, ..Default::default() }, &mut Selection { allow: &allow, choose: &mut choose });
    assert_eq!(result.candidates, 50);
    assert_eq!(result.hits.iter().map(|h| h.path.as_str()).collect::<Vec<_>>(), ["recent-14.md", "recent-13.md"]);
}

#[test]
fn related_scope_checks_source_and_filters_before_limit() {
    let mut engine = Engine::new();
    for path in ["allowed/Data Engineering.md", "allowed/Data-Engineering.md", "blocked/Data Engineering.md"] { engine.upsert(path, 1.0, "body"); }
    let allow = |doc: &Doc| doc.path.starts_with("allowed/");
    assert!(engine.similar_selected("blocked/Data Engineering.md", 10, 0.7, &allow).is_empty());
    let hits = engine.similar_selected("allowed/Data Engineering.md", 1, 0.7, &allow);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "allowed/Data-Engineering.md");
}

#[test]
fn korean_substrings_spacing_particles_and_field_positions() {
    let mut engine = Engine::new();
    for (path, body) in [
        ("request.md", "채점 기준을 세 단계로 나눠 줘"),
        ("reply.md", "채점기준표를 만들었습니다. 평가 항목은 셋입니다."),
        ("table.md", "기준 표를 붙여 줘"),
        ("cover.md", "표지를 바꿨습니다."),
        ("wrong.md", "채점과 다른 문장 뒤의 기준"),
        ("reverse.md", "기준 채점"),
    ] { engine.upsert(path, 1.0, body); }
    let paths = |q: &str| {
        let mut found: Vec<_> = engine.search(q, &SearchOptions::default()).hits.into_iter().map(|h| h.path).collect();
        found.sort(); found
    };
    assert_eq!(paths("기준"), paths("기준을"));
    assert_eq!(paths("채점기준"), ["reply.md", "request.md"]);
    assert_eq!(paths("채점기준표"), ["reply.md"]);
    assert_eq!(paths("기준표"), ["reply.md", "table.md"]);
    assert_eq!(paths("표"), ["cover.md", "reply.md", "table.md"]);
    let spaced = paths("채점 기준");
    assert!(spaced.contains(&"request.md".to_string()) && spaced.contains(&"reply.md".to_string()));
    let response = engine.search("채점 기준", &SearchOptions::default());
    let ex = response.hits.iter().find(|h| h.path == "request.md").unwrap().excerpt.as_ref().unwrap();
    let marked: Vec<_> = ex.ranges.iter().map(|&(a,b)| &ex.text[a as usize..b as usize]).collect();
    assert_eq!(marked, ["채점", "기준"]);
}

#[test]
fn cjk_metadata_replacement_and_unicode_ranges_preserve_raw_bytes() {
    use unicode_normalization::UnicodeNormalization;
    let mut engine = Engine::new();
    let raw = format!("📝 {} 끝", "채점기준표".nfd().collect::<String>());
    engine.upsert_with_fields("opaque.md", 1.0, &raw, DocumentFields {
        title: Some("💡 채점기준".into()), aliases: Some(vec!["예산집행".into()]), ..Default::default()
    });
    let result = engine.search("기준", &SearchOptions::default());
    assert_eq!(result.hits.len(), 1);
    let hit = &result.hits[0];
    assert_eq!(hit.title_ranges.iter().map(|&(a,b)| &hit.title_norm[a as usize..b as usize]).collect::<Vec<_>>(), ["기준"]);
    let ex = hit.excerpt.as_ref().unwrap();
    assert!(ex.ranges.iter().any(|&(a,b)| ex.text[a as usize..b as usize].nfc().collect::<String>() == "기준"));
    assert_eq!(engine.doc_text("opaque.md"), Some(raw.as_str()));
    assert_eq!(engine.search("산집", &SearchOptions::default()).hits.len(), 1);
    engine.upsert_with_fields("opaque.md", 2.0, "새 내용", DocumentFields { title: Some("후속".into()), aliases: Some(vec![]), ..Default::default() });
    assert!(engine.search("산집", &SearchOptions::default()).hits.is_empty());
    assert!(engine.search("기준", &SearchOptions::default()).hits.is_empty());
    engine.remove("opaque.md");
    engine.upsert("reuse.md", 3.0, "다른 문서");
    assert!(engine.search("채점", &SearchOptions::default()).hits.is_empty());
}

#[test]
fn cjk_mixed_scripts_and_title_tier_keep_upstream_ordering() {
    let mut engine = Engine::new();
    engine.upsert("AI교육.md", 1.0, "설명");
    engine.upsert("body.md", 1.0, "AI 교육 안내\n3 주차 설명\nmcp 서버");
    assert_eq!(engine.search("AI교육", &SearchOptions::default()).hits.len(), 2);
    assert_eq!(engine.search("AI교육", &SearchOptions::default()).hits[0].path, "AI교육.md");
    assert_eq!(engine.search("mcp서버", &SearchOptions::default()).hits[0].path, "body.md");
    assert_eq!(engine.search("3주차", &SearchOptions::default()).hits[0].path, "body.md");
    for word in ["회의", "강의", "평가", "결과", "자료", "어린이"] {
        assert_eq!(ff10k_core::cjk::strip_josa(word), word);
    }
    assert_eq!(ff10k_core::cjk::strip_josa("기준을"), "기준");
}

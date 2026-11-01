//! Workbench's CJK compatibility boundary. The upstream tokenizer and ranking stay intact.
//! A per-field gram -> distinct-token lookup supplies substring candidates; original token
//! postings still own positions, so a spaced match must be adjacent and in the same field.
use std::collections::HashSet;
use unicode_segmentation::UnicodeSegmentation;
use crate::normalize::normalize;

pub fn paired(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x11ff | 0x3040..=0x30ff | 0x3130..=0x318f |
        0x31f0..=0x31ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xa960..=0xa97f |
        0xac00..=0xd7ff | 0xf900..=0xfaff | 0x20000..=0x323af)
}

pub fn has_paired(s: &str) -> bool { !s.is_ascii() && s.chars().any(paired) }

/// Only CJK terms pay for this table. Pairs narrow candidates, single characters retain
/// the existing one-syllable lookup. Terms, not document bodies, are referenced by the table.
pub fn grams(s: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    if !has_paired(s) { return out; }
    let mut prev = None;
    for c in s.chars() {
        if paired(c) {
            out.insert(c.to_string());
            if let Some(p) = prev { out.insert(format!("{p}{c}")); }
            prev = Some(c);
        } else { prev = None; }
    }
    out
}

/// Preserve Workbench search-text.ts's bounded two-part spacing alternatives.
pub fn splits(s: &str) -> Vec<(&str, &str)> {
    let chars: Vec<_> = s.char_indices().collect();
    if chars.len() > 12 || !has_paired(s) { return Vec::new(); }
    let all = chars.iter().all(|x| paired(x.1));
    chars.iter().enumerate().skip(1).filter_map(|(n, &(b, c))| {
        ((all && n >= 2) || (!all && paired(chars[n - 1].1) != paired(c)))
            .then_some((&s[..b], &s[b..]))
    }).collect()
}

const JOSA: &[&str] = &["에서부터", "으로부터", "이라고는", "에서는", "에게서", "으로는", "으로도", "이라고", "이라는", "에서도",
    "라고", "라는", "에서", "에게", "한테", "부터", "까지", "처럼", "보다", "으로", "이나", "이랑", "랑",
    "과", "와", "의", "은", "는", "이", "가", "을", "를", "에", "로", "도", "만", "요"];
const KEEP: &[&str] = &["어린이", "고양이", "원숭이", "민주주의", "자본주의", "사회주의", "회의", "강의", "논의", "정의", "합의", "토의", "동의", "건의", "질의", "문의", "의의", "평가", "결과", "효과", "과제", "참가", "추가", "국가", "작가", "전문가", "단가", "학과", "교과", "부가", "대가", "정도", "지도", "제도", "속도", "의도", "온도", "태도", "자료", "경로", "통로", "도로", "진로", "기록", "수요", "필요", "중요", "개요", "요요", "주요", "아이", "차이", "사이", "나이", "높이", "길이", "깊이", "놀이", "바이", "이미지", "레이아웃"];

/// Same conservative particle rule as titles.ts; applies to plain terms, never quoted text.
pub fn strip_josa(word: &str) -> &str {
    if !has_paired(word) || KEEP.contains(&word) { return word; }
    for suffix in JOSA {
        let Some(stem) = word.strip_suffix(suffix) else { continue };
        let Some(last) = stem.chars().next_back() else { continue };
        if !('가'..='힣').contains(&last) { return stem; }
        if stem.chars().count() == 1 {
            let final_consonant = (last as u32 - 0xac00) % 28 != 0;
            if !(matches!(*suffix, "이" | "을" | "은") && final_consonant
                || matches!(*suffix, "가" | "를" | "는") && !final_consonant) { continue; }
        }
        if *suffix == "의" && stem.chars().count() < 3 && "주회강논정합토동건질문".contains(last) { continue; }
        return stem;
    }
    word
}

/// Exact normalized substring ranges mapped back to original UTF-8 grapheme boundaries.
/// This is only used for page details, never to scan all document bodies during ranking.
pub fn raw_ranges(raw: &str, words: &[(String, bool)]) -> Vec<(u32, u32)> {
    if !words.iter().any(|(w, _)| has_paired(w)) { return Vec::new(); }
    let mut normalized = String::new();
    let mut offsets = Vec::new();
    for (start, g) in raw.grapheme_indices(true) {
        let n = normalize(g);
        offsets.extend(std::iter::repeat_n((start as u32, (start + g.len()) as u32), n.len()));
        normalized.push_str(&n);
    }
    let mut out = Vec::new();
    for (word, _) in words.iter().filter(|(w, _)| has_paired(w)) {
        let needles = std::iter::once(word.as_str()).chain(splits(word).into_iter().flat_map(|(a, b)| [a, b]));
        for needle in needles {
            for (at, _) in normalized.match_indices(needle) {
                if let (Some(a), Some(b)) = (offsets.get(at), offsets.get(at + needle.len() - 1)) {
                    out.push((a.0, b.1));
                }
            }
        }
    }
    out
}

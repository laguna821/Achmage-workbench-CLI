//! One persistent ff10k engine over inherited JSONL pipes. No window, network or filesystem
//! traversal: the host owns source collection and scope. Requests/mutations execute in order.
//! Every request keeps its own id; one UI consumer can never cancel another UI/CLI consumer.

use ff10k_core::doc::{Doc, DocumentFields};
use ff10k_core::engine::{Config, Mode, SearchOptions};
use ff10k_core::rank::{Candidate, Selection};
use ff10k_core::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{self, BufRead, Read, Write};

pub const PROTOCOL: u8 = 1;
const MAX_FRAME: u64 = 32 * 1024 * 1024;
const MAX_TEXT: usize = 2 * 1024 * 1024;
const MAX_BATCH: usize = 500;
const UPSTREAM: &str = "714548efd3e361a7011a5123f4ae928630a01614";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub kind: String,
    pub scope: String,
    pub work_id: Option<String>,
    pub session_id: Option<String>,
    pub provider: Option<String>,
    pub archived: bool,
    pub hidden: bool,
    /// Optional host-established identity for chunks of the same message/document.
    pub dedup_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub key: String,
    pub revision: u64,
    pub mtime: f64,
    pub text: String,
    #[serde(default)]
    pub fields: DocumentFields,
    #[serde(default)]
    pub metadata: Metadata,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Removal {
    pub key: String,
    pub revision: u64,
}

#[derive(Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    // None means unrestricted; Some(empty) intentionally permits no documents.
    pub keys: Option<HashSet<String>>,
    pub kinds: Option<HashSet<String>>,
    pub scopes: Option<HashSet<String>>,
    pub work_ids: Option<HashSet<String>>,
    pub session_ids: Option<HashSet<String>>,
    pub providers: Option<HashSet<String>>,
    pub excluded_keys: HashSet<String>,
    pub excluded_work_ids: HashSet<String>,
    pub excluded_session_ids: HashSet<String>,
    pub archived: bool,
    pub properties: Vec<PropertyFilter>,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PropertyFilter {
    /// Exact host-parsed YAML key, including punctuation/colons.
    pub key: String,
    /// None tests presence (including empty/null values), Some tests a value.
    pub value: Option<String>,
}

impl Scope {
    fn allows(&self, doc: &Doc, meta: Option<&Metadata>) -> bool {
        let Some(meta) = meta else { return false };
        fn includes(set: &Option<HashSet<String>>, value: Option<&str>) -> bool {
            set.as_ref().is_none_or(|set| value.is_some_and(|value| set.contains(value)))
        }
        !meta.hidden && (self.archived || !meta.archived)
            && includes(&self.keys, Some(&doc.path))
            && includes(&self.kinds, Some(&meta.kind))
            && includes(&self.scopes, Some(&meta.scope))
            && includes(&self.work_ids, meta.work_id.as_deref())
            && includes(&self.session_ids, meta.session_id.as_deref())
            && includes(&self.providers, meta.provider.as_deref())
            && !self.excluded_keys.contains(&doc.path)
            && !meta.work_id.as_ref().is_some_and(|id| self.excluded_work_ids.contains(id))
            && !meta.session_id.as_ref().is_some_and(|id| self.excluded_session_ids.contains(id))
            && self.properties.iter().all(|wanted| doc.properties.iter().any(|p|
                p.key == wanted.key && wanted.value.as_ref().is_none_or(|v| p.values.contains(v))))
    }
}

#[derive(Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    #[default]
    None,
    Work,
    Session,
}

fn limit() -> usize { 30 }
fn per_group() -> usize { 3 }

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Search {
    pub query: String,
    pub scope: Scope,
    pub mode: Mode,
    pub offset: usize,
    pub limit: usize,
    pub group: Group,
    pub per_group: usize,
    pub now_secs: f64,
    pub debug: bool,
    /// Compact, ranked identities for the host's existing document/answer joins and Bases.
    /// Excerpts/headings are still generated only for the selected page.
    pub include_candidates: bool,
    /// Detail only identities chosen after the host's document/reply join. This is not a scope
    /// restriction: partial-match thresholds and counts still see the entire allowed corpus.
    pub detail_keys: Option<HashSet<String>>,
}

impl Default for Search {
    fn default() -> Self {
        Self { query: String::new(), scope: Scope::default(), mode: Mode::All, offset: 0,
            limit: limit(), group: Group::None, per_group: per_group(), now_secs: 0.0,
            debug: false, include_candidates: false, detail_keys: None }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    /// Reuse the upstream Canvas extractor before the host splits a long source into chunks.
    ExtractCanvas { text: String },
    Upsert { documents: Vec<Document> },
    Remove { documents: Vec<Removal> },
    Search { #[serde(flatten)] search: Search },
    Preview { key: String, #[serde(default)] scope: Scope },
    Similar { key: String, #[serde(default)] scope: Scope, #[serde(default = "limit")] limit: usize },
    RecordOpen { key: String, query: String, #[serde(rename = "nowSecs")] now_secs: f64 },
    SetAccess { key: String, timestamps: Vec<f64> },
    Configure { config: Config },
    ClearFrecency,
    WarmUp,
    Clear,
    Status,
    Shutdown,
}

#[derive(Deserialize)]
pub struct Input {
    pub version: u8,
    pub id: u64,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Default)]
pub struct Worker {
    engine: Engine,
    metadata: HashMap<String, Metadata>,
    // Tombstones prevent a delayed upsert from resurrecting a removed source.
    revisions: HashMap<String, u64>,
    generation: u64,
    scope_counts: Vec<(u64, Scope, usize)>,
}

impl Worker {
    pub fn handle(&mut self, request: Request) -> Result<Value, String> {
        match request {
            Request::ExtractCanvas { text } => {
                if text.len() > 16 * 1024 * 1024 { return Err("canvas source exceeds 16MB".into()); }
                Ok(json!({"text": ff10k_core::canvas::canvas_to_markdown(&text)}))
            }
            Request::Upsert { documents } => {
                if documents.len() > MAX_BATCH { return Err("search batch exceeds 500 documents".into()); }
                // Validate the complete batch before applying any of it.
                for doc in &documents {
                    if doc.key.is_empty() || doc.key.len() > 4096 || doc.text.len() > MAX_TEXT || !doc.mtime.is_finite() {
                        return Err("invalid search document key, size or time".into());
                    }
                }
                let mut changed = 0;
                for doc in documents {
                    if self.revisions.get(&doc.key).is_some_and(|&r| r >= doc.revision) { continue; }
                    self.revisions.insert(doc.key.clone(), doc.revision);
                    if doc.metadata.hidden {
                        self.engine.remove(&doc.key);
                        self.metadata.remove(&doc.key);
                    } else {
                        self.engine.upsert_with_fields(&doc.key, doc.mtime, &doc.text, doc.fields);
                        self.metadata.insert(doc.key, doc.metadata);
                    }
                    changed += 1;
                }
                self.generation += changed;
                Ok(json!({"changed": changed, "generation": self.generation, "documents": self.engine.doc_count()}))
            }
            Request::Remove { documents } => {
                if documents.len() > MAX_BATCH { return Err("search batch exceeds 500 documents".into()); }
                let mut changed = 0;
                for doc in documents {
                    if self.revisions.get(&doc.key).is_some_and(|&r| r >= doc.revision) { continue; }
                    self.revisions.insert(doc.key.clone(), doc.revision);
                    self.engine.remove(&doc.key);
                    self.metadata.remove(&doc.key);
                    changed += 1;
                }
                self.generation += changed;
                Ok(json!({"changed": changed, "generation": self.generation, "documents": self.engine.doc_count()}))
            }
            Request::Search { search } => self.search(search),
            Request::Preview { key, scope } => {
                if !self.engine.document(&key).is_some_and(|d| scope.allows(d, self.metadata.get(&key))) {
                    return Ok(json!({"found": false, "generation": self.generation}));
                }
                Ok(json!({"found": true, "key": key, "text": self.engine.doc_text(&key),
                    "revision": self.revisions.get(&key), "generation": self.generation}))
            }
            Request::Similar { key, scope, limit } => {
                let allow = |d: &Doc| scope.allows(d, self.metadata.get(&d.path));
                let hits = self.engine.similar_selected(&key, limit.min(100), 0.7, &allow);
                Ok(json!({"hits": hits, "generation": self.generation}))
            }
            Request::RecordOpen { key, query, now_secs } => {
                if self.metadata.contains_key(&key) && now_secs.is_finite() {
                    self.engine.record_access(&key, now_secs);
                    self.engine.record_query_open(&ff10k_core::query::Query::parse(&query).normalized, &key);
                }
                Ok(json!({}))
            }
            Request::SetAccess { key, timestamps } => { self.engine.set_access(&key, timestamps); Ok(json!({})) }
            Request::ClearFrecency => { self.engine.clear_frecency(); Ok(json!({})) }
            Request::Configure { config } => { self.engine.set_config(config); Ok(json!({})) }
            Request::WarmUp => { self.engine.warm_up(); Ok(json!({"generation": self.generation})) }
            Request::Clear => {
                self.engine.clear(); self.metadata.clear(); self.revisions.clear(); self.generation += 1;
                Ok(json!({"generation": self.generation}))
            }
            Request::Status => Ok(json!({"protocol": PROTOCOL, "upstream": UPSTREAM,
                "documents": self.engine.doc_count(), "generation": self.generation})),
            Request::Shutdown => Ok(json!({"stopped": true})),
        }
    }

    fn search(&mut self, search: Search) -> Result<Value, String> {
        if search.query.chars().count() > 4096 || search.limit > 500 || search.per_group > 100 {
            return Err("search request exceeds query/page limits".into());
        }
        let mut counts = BTreeMap::<String, usize>::new();
        let mut groups = Vec::<(String, Vec<usize>)>::new();
        let mut compact = Vec::<Value>::new();
        let mut total = 0;
        let allow = |d: &Doc| search.scope.allows(d, self.metadata.get(&d.path));
        let mut choose = |hits: &[Candidate<'_>]| {
            // rank may retry a permissive upstream query; each call completely replaces these.
            counts.clear(); groups.clear(); compact.clear(); total = 0;
            let mut seen = HashSet::new();
            let mut group_positions = HashMap::new();
            let mut indices = Vec::new();
            for (i, hit) in hits.iter().enumerate() {
                let meta = &self.metadata[&hit.doc.path];
                if !seen.insert(meta.dedup_key.as_deref().unwrap_or(&hit.doc.path)) { continue; }
                indices.push(i);
                total += 1;
                *counts.entry(meta.kind.clone()).or_default() += 1;
                if search.include_candidates { compact.push(json!({"key": hit.doc.path, "tier": hit.tier, "score": hit.score})); }
                let group = match search.group {
                    Group::Work => meta.work_id.as_deref().unwrap_or("vault"),
                    Group::Session => meta.session_id.as_deref().or(meta.work_id.as_deref()).unwrap_or("vault"),
                    Group::None => "all",
                };
                let at = *group_positions.entry(group).or_insert_with(|| { groups.push((group.to_string(), Vec::new())); groups.len() - 1 });
                groups[at].1.push(i);
            }
            if let Some(keys) = &search.detail_keys {
                indices.into_iter().filter(|&i| keys.contains(&hits[i].doc.path)).take(search.limit).collect()
            } else if search.group == Group::None {
                indices.into_iter().skip(search.offset).take(search.limit).collect()
            } else {
                groups.iter().skip(search.offset).take(search.limit).flat_map(|(_, indices)| indices.iter().take(search.per_group).copied()).collect()
            }
        };
        let opts = SearchOptions { mode: search.mode,
            limit: if search.group == Group::None { search.limit } else { search.limit.saturating_mul(search.per_group).min(500) },
            now_secs: search.now_secs, debug: search.debug };
        let count = self.scope_counts.iter().find(|(generation, scope, _)| *generation == self.generation && *scope == search.scope).map(|(_, _, count)| *count);
        let mut result = self.engine.search_selected_counted(&search.query, &opts, &mut Selection { allow: &allow, choose: &mut choose }, count);
        if count.is_none() {
            self.scope_counts.retain(|(generation, _, _)| *generation == self.generation);
            if self.scope_counts.len() >= 8 { self.scope_counts.remove(0); }
            self.scope_counts.push((self.generation, search.scope, result.total_docs));
        }
        // Same conversion as upstream plugin/src/worker.ts: JS offsets count UTF-16 units.
        for hit in &mut result.hits {
            to_utf16_ranges(&hit.title_norm, &mut hit.title_ranges);
            if let Some(excerpt) = &mut hit.excerpt { to_utf16_ranges(&excerpt.text, &mut excerpt.ranges); }
        }
        let group_counts: Vec<_> = groups.into_iter().map(|(key, hits)| json!({"key": key, "total": hits.len()})).collect();
        Ok(json!({"hits": result.hits, "total": total, "counts": counts, "groups": group_counts,
            "totalDocs": result.total_docs, "elapsedUs": result.elapsed_us, "generation": self.generation,
            "offset": search.offset, "limit": search.limit, "candidates": if search.include_candidates { Some(compact) } else { None }}))
    }
}

fn to_utf16_ranges(text: &str, ranges: &mut [(u32, u32)]) {
    if ranges.is_empty() { return; }
    let mut map = HashMap::from([(0_u32, 0_u32)]);
    let (mut bytes, mut units) = (0_u32, 0_u32);
    for c in text.chars() {
        bytes += c.len_utf8() as u32;
        units += c.len_utf16() as u32;
        map.insert(bytes, units);
    }
    for (a, b) in ranges { *a = *map.get(a).unwrap_or(&units); *b = *map.get(b).unwrap_or(&units); }
}

/// Public for a real pipe-level integration test; production passes locked stdin/stdout.
pub fn serve(input: &mut impl BufRead, output: &mut impl Write) -> io::Result<()> {
    let mut worker = Worker::default();
    loop {
        let mut bytes = Vec::new();
        let n = input.take(MAX_FRAME + 1).read_until(b'\n', &mut bytes)?;
        if n == 0 { return Ok(()); }
        if n as u64 > MAX_FRAME || !bytes.ends_with(b"\n") {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "oversized or incomplete search frame"));
        }
        let value: Result<Input, _> = serde_json::from_slice(&bytes);
        let (reply, stop) = match value {
            Ok(input) => {
                let stop = matches!(input.request, Request::Shutdown) && input.version == PROTOCOL;
                let result = if input.version == PROTOCOL { worker.handle(input.request) } else { Err("unsupported search protocol".into()) };
                let reply = match result {
                    Ok(result) => json!({"version": PROTOCOL, "id": input.id, "ok": true, "result": result}),
                    Err(error) => json!({"version": PROTOCOL, "id": input.id, "ok": false, "error": error}),
                };
                (reply, stop)
            }
            Err(error) => {
                let id = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("id").and_then(Value::as_u64));
                (json!({"version": PROTOCOL, "id": id, "ok": false, "error": error.to_string()}), false)
            }
        };
        serde_json::to_writer(&mut *output, &reply)?;
        output.write_all(b"\n")?;
        output.flush()?;
        if stop { return Ok(()); }
    }
}

pub fn run() -> i32 {
    match serve(&mut io::stdin().lock(), &mut io::stdout().lock()) {
        Ok(()) => 0,
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => 0,
        Err(error) => { eprintln!("search worker: {error}"); 1 }
    }
}

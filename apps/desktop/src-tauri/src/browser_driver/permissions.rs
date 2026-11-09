//! Profile-scoped decisions keyed by the actual native requesting origin and its embedding origin.
use std::{collections::HashMap, io::Write, path::PathBuf, sync::{Arc, Mutex}};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use super::{Page, new_id, now};
type Pages = Arc<Mutex<HashMap<String, Page>>>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule { id: String, profile_id: String, top_level_origin: String, requesting_origin: String, kind: String, allow: bool, updated_at: u64 }
pub struct Store { file: PathBuf, rules: Mutex<Vec<Rule>> }
pub fn origin(input: &str) -> Option<String> {
    let url = url::Url::parse(input).ok()?;
    if !matches!(url.scheme(), "https" | "http") || !url.username().is_empty() || url.password().is_some() { return None; }
    Some(url.origin().ascii_serialization())
}
impl Store {
    pub fn load(file: PathBuf) -> Result<Self, String> {
        let rules: Vec<Rule> = if file.exists() { serde_json::from_slice(&std::fs::read(&file).map_err(|error| error.to_string())?).map_err(|_| "저장된 사이트 권한을 읽지 못했습니다. 기존 파일은 보존했습니다.")? } else { Vec::new() };
        if rules.len() > 4096 || rules.iter().any(|rule| !super::super::identifier(&rule.profile_id) || origin(&rule.top_level_origin).as_deref() != Some(rule.top_level_origin.as_str()) || origin(&rule.requesting_origin).as_deref() != Some(rule.requesting_origin.as_str()) || rule.kind.len() > 80) { return Err("저장된 사이트 권한 형식이 올바르지 않습니다. 기존 파일은 보존했습니다.".into()); }
        Ok(Self { file, rules: Mutex::new(rules) })
    }
    fn write(&self, next: &[Rule]) -> Result<(), String> {
        let directory = self.file.parent().ok_or("사이트 권한 저장 경로가 없습니다.")?;
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut file, next).map_err(|error| error.to_string())?; file.flush().map_err(|error| error.to_string())?; file.as_file().sync_all().map_err(|error| error.to_string())?;
        file.persist(&self.file).map_err(|error| error.to_string())?; Ok(())
    }
    pub fn list(&self, profile: &str) -> Vec<Value> { self.rules.lock().unwrap().iter().filter(|rule| rule.profile_id == profile).map(|rule| json!(rule)).collect() }
    fn lookup(&self, profile: &str, top: &str, requester: &str, kind: &str) -> Option<bool> { self.rules.lock().unwrap().iter().find(|rule| rule.profile_id == profile && rule.top_level_origin == top && rule.requesting_origin == requester && rule.kind == kind).map(|rule| rule.allow) }
    fn save(&self, profile: &str, top: &str, requester: &str, kind: &str, allow: bool) -> Result<(), String> {
        let mut rules = self.rules.lock().unwrap(); let mut next = rules.clone();
        if let Some(rule) = next.iter_mut().find(|rule| rule.profile_id == profile && rule.top_level_origin == top && rule.requesting_origin == requester && rule.kind == kind) { rule.allow = allow; rule.updated_at = now(); }
        else { if next.len() >= 4096 { return Err("저장된 사이트 권한이 가득 찼습니다. 사용하지 않는 권한을 삭제해 주세요.".into()); } next.push(Rule { id: new_id(), profile_id: profile.into(), top_level_origin: top.into(), requesting_origin: requester.into(), kind: kind.into(), allow, updated_at: now() }); }
        self.write(&next)?; *rules = next; Ok(())
    }
    pub fn remove(&self, profile: &str, id: &str) -> Result<String, String> {
        let mut rules = self.rules.lock().unwrap(); let rule = rules.iter().find(|rule| rule.id == id && rule.profile_id == profile).ok_or("이 프로필의 저장된 권한이 아닙니다.")?;
        let top = rule.top_level_origin.clone(); let next: Vec<_> = rules.iter().filter(|rule| rule.id != id).cloned().collect(); self.write(&next)?; *rules = next; Ok(top)
    }
}
pub struct Request { pub id: String, pub revision: u64, pub expires: u64, pub saved: Option<bool> }
pub fn request(pages: &Pages, page_id: &str, kind: &str, requester: Option<String>, native_top: Option<String>) -> Option<Request> {
    let mut pages = pages.lock().unwrap(); let page = pages.get_mut(page_id)?;
    if page.permissions.len() >= 80 {
        if let Some(index) = page.permissions.iter().position(|request| request["status"] != "pending") { page.permissions.remove(index); } else { return None; }
    }
    let top = origin(&page.url);
    let requester = requester.and_then(|value| origin(&value));
    if top.is_none() || top != native_top { return None; } // A request from the departing document cannot inherit the new page's scope.
    let saved = top.as_ref().zip(requester.as_ref()).and_then(|(top, requester)| page.permission_store.lookup(&page.profile_id, top, requester, kind));
    let id = new_id(); let expires = now() + 60_000;
    page.permissions.push(json!({"id":id,"kind":kind,"pageUrl":page.url,"navigationRevision":page.navigation_revision,"topLevelOrigin":top,"requestingOrigin":requester,"requestedAt":now(),"expiresAt":expires,"remembered":saved.is_some(),"status":match saved { Some(true)=>"allowed",Some(false)=>"denied",None=>"pending" }}));
    Some(Request { id, revision: page.navigation_revision, expires, saved })
}
pub fn prepare(pages: &Pages, page_id: &str, request_id: &str, revision: u64, expires: u64, allow: bool, remember: bool) -> Result<(), String> {
    let page = pages.lock().unwrap().get(page_id).cloned().ok_or("웹 탭이 닫혔습니다.")?;
    if page.navigation_revision != revision || page.control.owner != "human" || expires <= now() { return Err("페이지나 제어권이 바뀌어 권한을 적용하지 않았습니다.".into()); }
    let request = page.permissions.iter().find(|entry| entry["id"] == request_id && entry["status"] == "pending").ok_or("이미 처리했거나 만료된 권한 요청입니다.")?;
    if remember {
        let top = request["topLevelOrigin"].as_str().ok_or("상위 사이트 출처를 확인하지 못해 저장하지 않았습니다.")?;
        let requester = request["requestingOrigin"].as_str().ok_or("요청한 프레임 출처를 확인하지 못해 저장하지 않았습니다.")?;
        let kind = request["kind"].as_str().ok_or("권한 종류를 확인하지 못했습니다.")?;
        page.permission_store.save(&page.profile_id, top, requester, kind, allow)?;
        refresh(pages, &page.profile_id);
    }
    Ok(())
}
pub fn settle(pages: &Pages, page_id: &str, request_id: &str, status: &str, remembered: bool) {
    if let Some(page) = pages.lock().unwrap().get_mut(page_id) { if let Some(request) = page.permissions.iter_mut().find(|entry| entry["id"] == request_id) { request["status"] = json!(status); request["remembered"] = json!(remembered); } }
}
pub fn refresh(pages: &Pages, profile: &str) {
    for page in pages.lock().unwrap().values_mut().filter(|page| page.profile_id == profile) { page.site_permissions = page.permission_store.list(profile); }
}

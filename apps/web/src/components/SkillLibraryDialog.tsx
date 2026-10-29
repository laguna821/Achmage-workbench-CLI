import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CREATE_LABEL, type CreatableFormat, type CreateTarget, type SkillImportPreview, type SkillUpdatePreview, type TemplatePreview, type WorkbenchSkill, type WorkbenchSkillDetail } from "@workbench/contracts";
import type { Api, SkillScope } from "../api.ts";
import { Icon } from "./Icon.tsx";
import "./skills.css";

const SOURCE: Record<WorkbenchSkill["source"], string> = { project: "프로젝트", claude: "Claude 설치", codex: "Codex 설치", shared: "공유 설치", plugin: "플러그인", imported: "내 보관함", ieum: "이음오피스", builtin: "기본 제공" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const emptyForm = { title: "", name: "", description: "", body: "", file: "" };

function PreviewPage({ api, page }: { api: Api; page: TemplatePreview["pages"][number] }) {
  const [src, setSrc] = useState<string | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let active = true, url: string | null = null;
    void api.skillBlob(page.url).then((blob) => {
      if (active) { url = URL.createObjectURL(blob); setSrc(url); }
    }, (reason) => { if (active) setError(message(reason)); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [api, page.url]);
  return <figure className="skill-preview-page">{src ? <img src={src} alt={`양식 ${page.page}쪽`} width={page.width} height={page.height} /> : <p>{error || "쪽을 여는 중…"}</p>}<figcaption>{page.page}쪽</figcaption></figure>;
}

/** The same library selects a template for a request and manages personal, portable skill copies. */
export function SkillLibraryDialog({ api, scope = {}, onClose, onPick }: { api: Api; scope?: SkillScope; onClose: () => void; onPick?: (target: CreateTarget) => void }) {
  const [skills, setSkills] = useState<WorkbenchSkill[]>([]), [detail, setDetail] = useState<WorkbenchSkillDetail | null>(null);
  const [preview, setPreview] = useState<TemplatePreview | null>(null), [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [mode, setMode] = useState<"list" | "new" | "import">("list");
  const [form, setForm] = useState(emptyForm), [edit, setEdit] = useState({ title: "", description: "", body: "" });
  const [sourceKind, setSourceKind] = useState<"folder" | "zip" | "github">("folder"), [source, setSource] = useState("");
  const [imported, setImported] = useState<SkillImportPreview | null>(null), [selected, setSelected] = useState<string[]>([]), [collisions, setCollisions] = useState<Record<string, "replace" | "skip">>({});
  const [update, setUpdate] = useState<SkillUpdatePreview | null>(null), [replaceLocal, setReplaceLocal] = useState(false);
  const [pending, setPending] = useState<{ text: string; action: () => void } | null>(null);
  const pendingImport = useRef<string | null>(null), pendingUpdate = useRef<string | null>(null);
  const scopeKey = JSON.stringify(scope);
  const currentScope = JSON.parse(scopeKey) as SkillScope;
  const dirty = mode === "new" ? Object.values(form).some(Boolean) : !!detail?.skill.editable && (edit.title !== detail.skill.title || edit.description !== detail.skill.description || edit.body !== detail.body);
  const leave = (action: () => void) => dirty ? setPending({ text: "아직 저장하지 않은 내용이 있습니다. 닫으면 작성한 내용을 버립니다.", action }) : action();
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (reason) { setError(message(reason)); } finally { setBusy(false); } };
  const reload = async () => { const items = await api.userSkills(currentScope); setSkills(items); return items; };
  const showDetail = (value: WorkbenchSkillDetail) => { setDetail(value); setEdit({ title: value.skill.title, description: value.skill.description, body: value.body }); setPreview(null); setUpdate(null); setReplaceLocal(false); setMode("list"); };
  const select = (id: string) => leave(() => { void run(async () => showDetail(await api.userSkill(id, currentScope))); });
  const showImport = async (value: SkillImportPreview) => {
    if (pendingImport.current) await api.discardSkillImport(pendingImport.current);
    pendingImport.current = value.id; setImported(value); setSelected(value.candidates.filter((item) => !item.problem).map((item) => item.key)); setCollisions({});
  };
  useEffect(() => {
    let active = true;
    void api.userSkills(JSON.parse(scopeKey)).then((items) => { if (active) setSkills(items); }, (reason) => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [api, scopeKey]);
  useEffect(() => () => {
    if (pendingImport.current) void api.discardSkillImport(pendingImport.current).catch(() => undefined);
    if (pendingUpdate.current) void api.discardSkillImport(pendingUpdate.current).catch(() => undefined);
  }, [api]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if (!busy) leave(onClose); } };
    window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true);
  });
  const pickPath = async (folder: boolean, put: (path: string) => void) => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const value = await open({ directory: folder, multiple: false, title: folder ? "스킬 폴더 선택" : "양식·ZIP 파일 선택" });
    if (typeof value === "string") put(value);
  };
  const filtered = skills.filter((skill) => `${skill.title} ${skill.name} ${skill.description} ${SOURCE[skill.source]}`.toLowerCase().includes(query.toLowerCase()));
  const skill = detail?.skill;
  const canPick = preview && Object.hasOwn(CREATE_LABEL, preview.format) && skill?.state.enabled && !skill.shadowedBy;
  return createPortal(<div className="modal-backdrop skill-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) leave(onClose); }}>
    <section className="skill-library" role="dialog" aria-modal="true" aria-label="양식·스킬 보관함">
      <header className="skill-head"><div><h2>양식·스킬 보관함</h2><p>설치된 스킬과 내 양식으로 새 문서를 만듭니다.</p></div><button className="icon-button" disabled={busy} onClick={() => leave(onClose)} aria-label="보관함 닫기"><Icon name="x" size={18} /></button></header>
      {error ? <p className="notice notice-error compact" role="alert">{error}</p> : null}
      {pending ? <div className="skill-confirm" role="alertdialog"><p>{pending.text}</p><button className="button small" onClick={() => setPending(null)}>계속 작성</button><button className="button small" onClick={() => { const action = pending.action; setPending(null); action(); }}>확인</button></div> : null}
      <div className="skill-toolbar"><input className="sheet-input" aria-label="양식·스킬 검색" placeholder="이름·설명으로 찾기" value={query} onChange={(event) => setQuery(event.target.value)} /><button className="button small" disabled={busy} onClick={() => leave(() => { setMode("new"); setDetail(null); setPreview(null); setForm(emptyForm); })}>내 양식 등록</button><button className="button small" disabled={busy} onClick={() => leave(() => { setMode("import"); setDetail(null); setPreview(null); })}>가져오기</button><button className="button small" disabled={busy} onClick={() => void run(async () => { await reload(); })}>새로고침</button></div>
      <div className="skill-columns">
        <nav className="skill-list" aria-label="설치된 양식·스킬">{filtered.map((item) => <button key={item.id} className={`skill-row${skill?.id === item.id ? " active" : ""}`} disabled={busy} onClick={() => select(item.id)}><strong>{item.title}</strong><span>{SOURCE[item.source]} · {item.template ? "양식 포함" : "스킬"} · {item.shadowedBy ? "같은 이름의 우선 판 있음" : item.state.enabled ? "사용" : "꺼짐"}</span><small>{item.description || item.problem}</small></button>)}{!filtered.length ? <p className="sheet-hint">찾은 스킬이 없습니다. 양식 파일을 등록하거나 스킬 폴더를 가져오세요.</p> : null}</nav>
        <main className="skill-detail">
          {mode === "new" ? <div className="skill-form"><h3>내 양식 등록</h3><p className="sheet-hint">선택한 문서를 보관함에 복사합니다. 원본 파일은 유지합니다.</p>
            <label>양식 이름<input className="sheet-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
            <label>설명<input className="sheet-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
            <label>양식 파일 경로<div className="skill-path"><input className="sheet-input" value={form.file} onChange={(e) => setForm({ ...form, file: e.target.value })} placeholder="양식 없이 스킬만 등록할 수도 있습니다" />{"__TAURI_INTERNALS__" in window ? <button className="button small" onClick={() => void run(() => pickPath(false, (file) => setForm({ ...form, file })))}>파일 선택</button> : null}</div></label>
            <label>작성 방법<textarea className="sheet-input" rows={8} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="이 양식을 채울 때 지킬 내용·서식을 적어 주세요." /></label>
            <button className="button primary" disabled={busy || !form.title.trim() || !form.description.trim()} onClick={() => void run(async () => showImport(await api.registerSkill(form, currentScope)))}>등록 내용 확인</button>
          </div> : mode === "import" ? <div className="skill-form"><h3>스킬 가져오기</h3><label>가져올 위치<select className="sheet-input" value={sourceKind} onChange={(e) => setSourceKind(e.target.value as typeof sourceKind)}><option value="folder">폴더</option><option value="zip">ZIP 파일</option><option value="github">GitHub</option></select></label><div className="skill-path"><input className="sheet-input" aria-label="스킬 가져올 경로" value={source} onChange={(e) => setSource(e.target.value)} placeholder={sourceKind === "github" ? "https://github.com/owner/repo" : "이 컴퓨터의 경로"} />{sourceKind !== "github" && "__TAURI_INTERNALS__" in window ? <button className="button small" onClick={() => void run(() => pickPath(sourceKind === "folder", setSource))}>찾기</button> : null}</div><button className="button primary" disabled={busy || !source.trim()} onClick={() => void run(async () => showImport(await api.prepareSkillImport(sourceKind, source)))}>가져올 내용 확인</button></div>
          : detail && skill ? <>
            <div className="skill-detail-head"><h3>{skill.title}</h3><span>{SOURCE[skill.source]}</span></div>
            <p className="sheet-hint skill-location">{skill.dir}</p>
            {skill.shadowedBy ? <p className="sheet-hint">같은 이름의 프로젝트·설치 스킬이 우선합니다.</p> : null}
            <label className="skill-toggle"><input type="checkbox" checked={skill.state.enabled} disabled={busy || !!skill.problem} onChange={(e) => void run(async () => { const updated = await api.skillState(skill.id, { ...skill.state, enabled: e.target.checked }, currentScope); setDetail({ ...detail, skill: updated }); await reload(); })} />Workbench에서 선택해 사용</label>
            <p className="sheet-hint">엔진 자체의 설치 설정은 해당 엔진에서 관리합니다.</p>
            <div className="skill-actions">
              {skill.template ? <button className="button small primary" disabled={busy} onClick={() => void run(async () => setPreview(await api.templatePreview(skill.id, currentScope)))}>양식 미리보기</button> : null}
              <button className="button small" disabled={busy} onClick={() => void run(async () => showImport(await api.cloneSkill(skill.id, currentScope)))}>보관함에 사본</button>
              <button className="button small" disabled={busy} onClick={() => void run(async () => { const blob = await api.exportSkill(skill.id, currentScope), url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${skill.name}.zip`; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30_000); })}>ZIP 내보내기{skill.template ? " (양식 포함)" : ""}</button>
              {skill.github && skill.editable ? <button className="button small" disabled={busy} onClick={() => void run(async () => { if (pendingUpdate.current) await api.discardSkillImport(pendingUpdate.current); const value = await api.skillUpdate(skill.id, currentScope); pendingUpdate.current = value.id; setUpdate(value); })}>업데이트 확인</button> : null}
            </div>
            {preview ? <section className="skill-preview"><h4>{preview.name}</h4><p className="sheet-hint">{Math.round(preview.size / 1024)} KB · 확인한 판 {preview.template.sha256.slice(0, 12)}</p>{preview.problem ? <p className="notice compact">{preview.problem}</p> : null}{preview.text !== null ? <pre>{preview.text}</pre> : preview.pages.map((page) => <PreviewPage key={page.url} api={api} page={page} />)}{onPick ? <button className="button primary" disabled={busy || !canPick || dirty} onClick={() => { onPick({ format: preview.format as CreatableFormat, name: preview.name.replace(/\.design\.json$/i, "").replace(/\.[^.]+$/, ""), template: preview.template }); onClose(); }}>이 양식으로 새 문서</button> : null}{!Object.hasOwn(CREATE_LABEL, preview.format) ? <p className="sheet-hint">이 형식은 읽기용입니다. 새 문서는 편집 가능한 형식으로 등록해 주세요.</p> : null}</section> : null}
            {update ? <section className="skill-update"><h4>{update.status === "up-to-date" ? "최신 판입니다" : "새 판의 변경 내용"}</h4><p>{update.commit.slice(0, 12)}</p><ul>{update.changes.map((change) => <li key={change.rel}>{change.change} · {change.rel}</li>)}</ul>{update.locallyEdited ? <label><input type="checkbox" checked={replaceLocal} onChange={(e) => setReplaceLocal(e.target.checked)} />수정한 로컬 판을 백업하고 새 판으로 교체</label> : null}{update.id ? <button className="button small primary" disabled={busy || (update.locallyEdited && !replaceLocal)} onClick={() => void run(async () => { await api.applySkillUpdate(update.id!, replaceLocal, currentScope); pendingUpdate.current = null; showDetail(await api.userSkill(skill.id, currentScope)); await reload(); })}>업데이트 적용</button> : null}</section> : null}
            {skill.editable ? <div className="skill-form"><h4>내 사본 편집</h4><label>이름<input className="sheet-input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></label><label>설명<input className="sheet-input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></label><label>작성 방법<textarea className="sheet-input" rows={8} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></label><div className="skill-actions"><button className="button small primary" disabled={busy || !dirty} onClick={() => void run(async () => { showDetail(await api.saveSkill(skill.id, { ...edit, sha256: detail.sha256 }, currentScope)); await reload(); })}>사본 저장</button><button className="button small" disabled={busy} onClick={() => setPending({ text: "보관함에서 이 스킬을 빼고 백업 폴더에 보관합니다.", action: () => { void run(async () => { await api.removeSkill(skill.id, detail.sha256, currentScope); setDetail(null); setPreview(null); await reload(); }); } })}>보관함에서 빼기</button></div></div> : <details><summary>스킬 설명 보기</summary><pre className="skill-source">{detail.markdown}</pre></details>}
          </> : <div className="skill-empty"><h3>내 문서의 형식을 그대로</h3><p>양식을 고르고 미리보기를 확인하세요. 요청을 보낼 때 작업 폴더에 새 사본을 만듭니다.</p></div>}
        </main>
      </div>
      {imported ? <div className="skill-import-overlay"><section role="dialog" aria-label="가져오기 확인"><h3>가져오기 확인</h3>{error ? <p className="notice notice-error compact" role="alert">{error}</p> : null}<p className="skill-location">{imported.origin}</p><p className="sheet-hint">가져온 스킬은 꺼진 상태로 보관합니다. 사용하려면 목록에서 선택해 주세요.</p>{imported.candidates.map((candidate) => <div className="skill-candidate" key={candidate.key}><label><input type="checkbox" disabled={busy || !!candidate.problem} checked={selected.includes(candidate.key)} onChange={(e) => setSelected(e.target.checked ? [...selected, candidate.key] : selected.filter((key) => key !== candidate.key))} /><strong>{candidate.title}</strong></label><p>{candidate.description}</p><small>{candidate.files}개 파일 · {Math.round(candidate.bytes / 1024)} KB{candidate.hasTemplate ? " · 양식 포함" : ""}{candidate.hasScripts ? " · 실행 스크립트 포함" : ""}{candidate.license ? ` · ${candidate.license}` : ""}{candidate.problem ? ` · ${candidate.problem}` : ""}</small>{candidate.collision ? <label>같은 이름<select aria-label={`${candidate.title} 충돌 처리`} value={collisions[candidate.key] ?? ""} onChange={(e) => setCollisions({ ...collisions, [candidate.key]: e.target.value as "replace" | "skip" })}><option value="">선택하세요</option><option value="skip">이번 항목 건너뛰기</option><option value="replace">기존 판 백업 후 교체</option></select></label> : null}{candidate.urls.length ? <details><summary>포함된 웹 주소</summary>{candidate.urls.map((url) => <p key={url}>{url}</p>)}</details> : null}</div>)}<div className="skill-actions"><button className="button small" disabled={busy} onClick={() => void run(async () => { await api.discardSkillImport(imported.id); pendingImport.current = null; setImported(null); })}>취소</button><button className="button primary" disabled={busy || !selected.length || imported.candidates.some((item) => selected.includes(item.key) && item.collision && !collisions[item.key])} onClick={() => void run(async () => { await api.installSkills(imported.id, selected, collisions); pendingImport.current = null; setImported(null); setMode("list"); setForm(emptyForm); const items = await reload(); const first = items.find((item) => item.source === "imported" && imported.candidates.some((entry) => selected.includes(entry.key) && entry.name === item.name)); if (first) showDetail(await api.userSkill(first.id, currentScope)); })}>보관함에 가져오기</button></div></section></div> : null}
      {busy ? <div className="skill-busy" role="status">처리 중…</div> : null}
    </section>
  </div>, document.body);
}

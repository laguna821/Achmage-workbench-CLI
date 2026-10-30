import { useEffect, useRef, useState } from "react";
import type { GitRef, ScmComparison, ScmComparisonDiff, ScmComparisonRequest, ScmComparisonPreferences, Workspace } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { ScmDiffText } from "./ScmDiffText.tsx";

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (oid: string | null) => oid?.slice(0, 10) ?? "빈 기준";
type Form = ScmComparisonPreferences;
function initial(workspace: Workspace, defaultBase: string): Form {
  const fallback: Form = { mode: "combined", base: defaultBase, head: "HEAD", merge: true, parent: 1, wrap: false };
  try {
    const data = JSON.parse(localStorage.getItem(`scm-comparison:${workspace.id}`) ?? "null");
    if (data && ["combined", "branch", "commit"].includes(data.mode) && typeof data.base === "string" && typeof data.head === "string" && data.base.length <= 1024 && data.head.length <= 1024 && typeof data.merge === "boolean" && Number.isInteger(data.parent) && data.parent >= 1 && data.parent <= 100 && typeof data.wrap === "boolean") return data as Form;
  } catch { /* Invalid or unavailable preferences do not prevent review. */ }
  return fallback;
}
export function ScmComparisonReview({ api, workspace, defaultBase, refreshEpoch }: { api: Api; workspace: Workspace; defaultBase: string; refreshEpoch: number }) {
  const [form, setForm] = useState(() => initial(workspace, defaultBase)), formRef = useRef(form);
  const [view, setView] = useState<ScmComparison | null>(null), [refs, setRefs] = useState<GitRef[]>([]), [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<ScmComparisonDiff | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [imageMode, setImageMode] = useState<"side" | "overlay">("side"), version = useRef(0);
  const [ready, setReady] = useState(false), [preferenceError, setPreferenceError] = useState(""), [saving, setSaving] = useState(false);
  const saveVersion = useRef(0), [preferenceEpoch, setPreferenceEpoch] = useState(0);
  formRef.current = form;
  useEffect(() => {
    let canceled = false;
    void api.scmComparisonPreferences(workspace.id).then((saved) => { if (!canceled) { if (saved) setForm(saved); setReady(true); } }).catch((reason) => { if (!canceled) setPreferenceError(messageOf(reason)); });
    return () => { canceled = true; };
  }, [api, workspace.id, preferenceEpoch]);
  useEffect(() => {
    if (!ready || !Number.isInteger(form.parent) || form.parent < 1 || form.parent > 100) return;
    const current = ++saveVersion.current; let canceled = false; setSaving(true);
    void api.saveScmComparisonPreferences(workspace.id, form).then(() => { if (!canceled && current === saveVersion.current) { setSaving(false); setPreferenceError(""); } }).catch((reason) => { if (!canceled && current === saveVersion.current) { setSaving(false); setPreferenceError(messageOf(reason)); } });
    return () => { canceled = true; };
  }, [api, ready, form, workspace.id]);
  const load = async () => {
    const current = ++version.current, f = formRef.current; setLoading(true); setError(""); setDiff(null); setView(null);
    const request: ScmComparisonRequest = f.mode === "commit" ? { mode: f.mode, headRef: f.head, parent: f.parent } : { mode: f.mode, baseRef: f.base, ...(f.mode === "branch" ? { headRef: f.head, mergeBase: f.merge } : {}) };
    try {
      const result = await api.scmCompare(workspace.id, request); if (current !== version.current) return;
      setView(result); setSelected((path) => result.files.some((file) => file.path === path) ? path : result.files[0]?.path ?? null);
    } catch (reason) { if (current === version.current) setError(messageOf(reason)); }
    finally { if (current === version.current) setLoading(false); }
  };
  useEffect(() => { if (ready) void load(); return () => { version.current++; }; }, [api, ready, workspace.id, refreshEpoch]);
  useEffect(() => { let canceled = false; void api.workspaceRepository(workspace.id).then((repo) => { if (!canceled) setRefs(repo.refs); }).catch(() => { /* Arbitrary refs remain available without suggestions. */ }); return () => { canceled = true; }; }, [api, workspace.id]);
  useEffect(() => {
    let canceled = false; setDiff(null);
    if (view && selected) void api.scmCompareDiff(workspace.id, view, selected).then((result) => { if (!canceled) setDiff(result); }).catch((reason) => { if (!canceled) setError(messageOf(reason)); });
    return () => { canceled = true; };
  }, [api, workspace.id, view, selected]);
  if (!ready) return <div className="scm-comparison"><p className={preferenceError ? "scm-error" : "scm-placeholder"}>{preferenceError || "비교 설정을 불러오는 중…"}</p>{preferenceError ? <button className="button" onClick={() => { setPreferenceError(""); setPreferenceEpoch((value) => value + 1); }}>설정 다시 불러오기</button> : null}</div>;
  return <div className="scm-comparison">
    {preferenceError ? <p className="scm-error" role="alert">비교 설정을 저장·복원하지 못했습니다: {preferenceError}</p> : null}
    <form className="scm-compare-form" onSubmit={(event) => { event.preventDefault(); void load(); }}>
      <fieldset className="scm-compare-choice"><legend>비교 방식</legend>{([["combined", "작업 변경 전체"], ["branch", "브랜치·기준 비교"], ["commit", "한 커밋의 변경"]] as const).map(([mode, label]) => <label key={mode}><input className="scm-compare-mode" type="radio" name="scm-compare-mode" value={mode} checked={form.mode === mode} onChange={() => setForm({ ...form, mode })} />{label}</label>)}</fieldset>
      {form.mode !== "commit" ? <label>기준<input className="scm-compare-base" list="scm-compare-refs" value={form.base} maxLength={1024} placeholder={defaultBase || "첫 커밋 전 · 빈 기준"} onChange={(event) => setForm({ ...form, base: event.target.value })} /></label> : null}
      {form.mode !== "combined" ? <label>{form.mode === "commit" ? "커밋" : "비교 대상"}<input className="scm-compare-head" list="scm-compare-refs" value={form.head} maxLength={1024} onChange={(event) => setForm({ ...form, head: event.target.value })} /></label> : null}
      {form.mode === "branch" ? <fieldset className="scm-compare-choice"><legend>비교 시작</legend><label><input className="scm-compare-merge" type="radio" name="scm-compare-merge" value="merge" checked={form.merge} onChange={() => setForm({ ...form, merge: true })} />두 브랜치의 공통 조상</label><label><input className="scm-compare-merge" type="radio" name="scm-compare-merge" value="ends" checked={!form.merge} onChange={() => setForm({ ...form, merge: false })} />기준 커밋 자체 · 두 끝점</label></fieldset> : null}
      {form.mode === "commit" ? <label>부모 번호<input className="scm-compare-parent" type="number" min={1} max={100} value={form.parent} onChange={(event) => setForm({ ...form, parent: Number(event.target.value) })} /></label> : null}
      <datalist id="scm-compare-refs">{refs.map((ref) => <option key={ref.kind + ref.name} value={ref.name}>{ref.kind} · {ref.commit.slice(0, 8)}</option>)}</datalist>
      <button className="button primary scm-compare-load" disabled={!ready || loading}>{loading ? "불러오는 중…" : "비교 불러오기"}</button><small className="scm-compare-saving" role="status">{!ready ? "설정 불러오는 중…" : saving ? "설정 저장 중…" : preferenceError ? "설정 저장 확인 필요" : "설정 저장됨"}</small>
    </form>
    <p className="scm-compare-help">{form.mode === "combined" ? "기준부터 현재 작업 파일까지 비교합니다. 커밋한 변경과 스테이징·미추적 파일도 포함합니다." : form.mode === "branch" ? "공통 조상은 대상 브랜치에서 만든 변경을, 두 끝점은 두 커밋 자체의 차이를 보여 줍니다." : "부모와 선택한 커밋을 비교합니다. 첫 커밋은 빈 기준, 병합 커밋은 선택한 부모를 사용합니다."}</p>
    {error ? <p className="scm-error" role="alert">{error}</p> : null}
    {view ? <><div className="scm-compare-summary"><strong>{view.files.length}개 파일</strong><span>{view.request.mode === "commit" ? `커밋 ${view.request.headRef} · 부모 ${view.request.parent}` : `기준 ${view.request.baseRef || "빈 기준"}${view.request.mode === "branch" && view.request.mergeBase ? " · 공통 조상부터" : ""}`}</span><code title={view.beforeOid ?? "빈 기준"}>{short(view.beforeOid)}</code><span>→</span><code title={view.headOid ?? "첫 커밋 전"}>{view.after === "working" ? `작업 파일 · HEAD ${short(view.headOid)}` : short(view.headOid)}</code>{view.baseOid !== view.beforeOid ? <small title={view.baseOid ?? ""}>기준 끝점 {short(view.baseOid)}</small> : null}</div>
      <div className="scm-body"><aside className="scm-sidebar"><section className="scm-file-section">{view.files.map((file) => <div className={`scm-file${selected === file.path ? " selected" : ""}`} key={file.path}><button className="scm-file-select scm-compare-file" data-path={file.path} title={file.intermediateOnly ? "최종 차이 없이 중간 스테이징 변경만 있을 수 있습니다." : file.path} onClick={() => { setError(""); setSelected(file.path); }}><span>{file.conflicted ? "!" : file.change}</span><span>{file.oldPath ? `${file.oldPath} → ` : ""}{file.path}</span></button></div>)}{!view.files.length ? <p className="muted">이 기준에서 변경이 없습니다.</p> : null}</section></aside>
      <main className={`scm-review${form.wrap ? " wrap" : ""}`}>{selected ? <><header className="scm-diff-header"><strong>{selected}</strong><span>읽기 전용 비교</span><label><input className="scm-compare-wrap" type="checkbox" checked={form.wrap} onChange={(event) => setForm({ ...form, wrap: event.target.checked })} />줄바꿈</label></header>{diff ? <>{diff.notice ? <p className="scm-warning">{diff.notice}</p> : null}{diff.truncated ? <p className="scm-warning">차이가 커서 앞부분만 표시합니다.</p> : null}{diff.images ? <><div className="scm-image-tools"><button className="button small" onClick={() => setImageMode(imageMode === "side" ? "overlay" : "side")}>{imageMode === "side" ? "겹쳐 보기" : "나란히 보기"}</button><span>이전 / 이후 · 최대 8 MiB</span></div><div className={`scm-images ${imageMode}`}>{(["before", "after"] as const).map((side) => <figure key={side}>{diff.images![side] ? <img src={diff.images![side]!} alt={side === "before" ? "이전 이미지" : "이후 이미지"} /> : <span>이미지 없음 또는 크기 제한</span>}<figcaption>{side === "before" ? "이전" : "이후"}</figcaption></figure>)}</div></> : null}<ScmDiffText diff={diff} /></> : <p className="scm-placeholder">{error ? "비교를 새로 불러와 주세요." : "차이를 불러오는 중…"}</p>}</> : <p className="scm-placeholder">비교할 파일을 선택하세요.</p>}</main></div></> : !error ? <p className="scm-placeholder">비교 기준을 불러오는 중…</p> : null}
  </div>;
}

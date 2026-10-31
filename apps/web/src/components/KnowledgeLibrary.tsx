import { useEffect, useState } from "react";
import type { Api } from "../api.ts";
import type { KnowledgeHit, KnowledgeLibrary as Library } from "../../../../packages/contracts/src/office-knowledge.ts";
import "../styles/knowledge.css";

export function KnowledgeLibrary({ api, onClose }: { api: Api; onClose(): void }) {
  const [library, setLibrary] = useState<Library>({ items: [], groups: [] });
  const [paths, setPaths] = useState(""), [group, setGroup] = useState(""), [filter, setFilter] = useState("*");
  const [selected, setSelected] = useState<string[]>([]), [query, setQuery] = useState("");
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(""); try { await action(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  useEffect(() => { let live = true; void api.knowledgeLibrary().then(value => { if (live) setLibrary(value); }, error => { if (live) setError(String(error)); }); return () => { live = false; }; }, [api]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); if (!busy) onClose(); } }; window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true); }, [busy, onClose]);
  const change = (action: string, chosen = selected) => run(async () => { setLibrary(await api.knowledgeAction<Library>(action, { paths: chosen, group })); setSelected([]); setHits(null); if (action === "add") setPaths(""); });
  const addPaths = () => paths.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
  const pick = () => run(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({ title: "지식베이스에 추가할 파일", multiple: true, directory: false });
    if (!chosen) return;
    setLibrary(await api.knowledgeAction<Library>("add", { paths: Array.isArray(chosen) ? chosen : [chosen], group })); setHits(null);
  });
  const shown = library.items.filter(item => filter === "*" || (item.group ?? "") === filter);
  return <div className="knowledge-overlay">
    <section className="knowledge-library" role="dialog" aria-modal="true" aria-label="지식베이스">
      <header><h2>지식베이스</h2><button type="button" className="icon-button" aria-label="지식베이스 닫기" disabled={busy} onClick={onClose}>×</button></header>
      <p>별표로 모은 파일을 문서 AI가 검색하고 인용합니다. 그룹으로 나누어 관리할 수 있습니다.</p>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); void change("add", addPaths()); }}>
        <label>추가할 파일 경로<textarea aria-label="추가할 파일 경로" value={paths} onChange={event => setPaths(event.target.value)} placeholder="파일 경로를 한 줄에 하나씩 입력" rows={2} /></label>
        <div className="knowledge-actions"><button type="submit" disabled={busy || !addPaths().length}>별표에 추가</button>{"__TAURI_INTERNALS__" in window && <button type="button" disabled={busy} onClick={() => void pick()}>파일 선택…</button>}</div>
      </form>
      <div className="knowledge-actions"><label>그룹 이름 <input aria-label="그룹 이름" value={group} maxLength={200} onChange={event => setGroup(event.target.value)} list="knowledge-groups" /></label><datalist id="knowledge-groups">{library.groups.map(name => <option key={name} value={name} />)}</datalist><button disabled={busy || !selected.length} onClick={() => void change("group")}>그룹 적용</button><button disabled={busy || !selected.length} onClick={() => void change("remove")}>별표 해제</button></div>
      <form className="knowledge-actions" onSubmit={event => { event.preventDefault(); void run(async () => setHits(await api.knowledgeAction<KnowledgeHit[]>("search", { query, ...(filter === "*" ? {} : { group: filter }) }))); }}>
        <select aria-label="그룹 보기" value={filter} onChange={event => { setFilter(event.target.value); setHits(null); }}><option value="*">모든 그룹</option><option value="">그룹 없음</option>{library.groups.map(name => <option key={name} value={name}>{name}</option>)}</select>
        <input aria-label="지식베이스 검색어" placeholder="파일 이름·본문 검색" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} /><button disabled={busy || !query.trim()}>검색</button><button type="button" onClick={() => setHits(null)}>목록</button>
      </form>
      <div className="knowledge-list" aria-busy={busy}>
        {hits ? <><p>{hits.length}개 검색 결과</p>{hits.map(hit => <article key={hit.path}><strong>{hit.name}</strong><small>{hit.path}</small><p>{hit.snippet}</p></article>)}</> : <><p>별표 파일 {shown.length}개</p>{shown.map(item => <label className="knowledge-row" key={item.path}><input type="checkbox" aria-label={`선택 ${item.file?.name ?? item.path}`} checked={selected.includes(item.path)} onChange={event => setSelected(event.target.checked ? [...selected, item.path] : selected.filter(path => path !== item.path))} /><span><strong>{item.file?.name ?? item.path.split(/[\/\\]/).at(-1)}</strong><small>{item.path}</small></span><span>{item.missing ? "파일을 찾을 수 없음" : item.group ?? "그룹 없음"}</span></label>)}</>}
      </div>
    </section>
  </div>;
}

import { useEffect, useState } from "react";
import type { OfficeDocumentChoice } from "../../../../../packages/contracts/src/office-references.ts";

export function OfficeReferencePicker({ items, choose }: { items: OfficeDocumentChoice[]; choose(paths: string[] | null): void }) {
  const [query, setQuery] = useState(""), [paths, setPaths] = useState<string[]>([]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); choose(null); } };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [choose]);
  const shown = items.filter((item) => `${item.name} ${item.dir}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) choose(null); }}>
    <form className="stage-dialog office-reference-picker" role="dialog" aria-modal="true" aria-label="문서에서 첨부" onSubmit={(event) => { event.preventDefault(); choose(paths); }}>
      <header className="template-head"><h2>문서에서 첨부</h2></header>
      <input className="sheet-input" aria-label="참조 문서 찾기" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="문서 이름 또는 폴더" />
      <p className="sheet-hint">프로젝트 문서를 20개까지 선택하세요. 요청을 보낼 때 최신 편집을 저장해 참조합니다.</p>
      <div className="office-reference-options">
        {shown.map((item) => <label key={item.path} className="office-reference-option">
          <input type="checkbox" checked={paths.includes(item.path)} disabled={item.state !== "ok" || paths.length >= 20 && !paths.includes(item.path)} onChange={(event) => setPaths((current) => event.target.checked ? [...current, item.path] : current.filter((path) => path !== item.path))} />
          <span><strong>{item.name}</strong><small>{item.dir} · {item.state === "modified" ? "저장 필요" : item.group === "open" ? "열린 문서" : "최근 문서"}</small></span>
        </label>)}
        {!shown.length ? <p className="sheet-hint">선택할 문서가 없습니다.</p> : null}
      </div>
      <footer className="stage-foot"><span>{paths.length}개 선택</span><span className="stage-spacer" /><button type="button" className="button small" onClick={() => choose(null)}>취소</button><button type="submit" className="button small primary" disabled={!paths.length}>첨부</button></footer>
    </form>
  </div>;
}

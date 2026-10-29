import { useEffect, useRef, useState } from "react";
import type { Folder, FolderNoteTemplate } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { Icon } from "../Icon.tsx";

export function FolderTemplateDialog({ api, folder, onClose, onSaved, onError }: { api: Api; folder: Folder; onClose: () => void; onSaved: () => void; onError: (error: unknown) => void }) {
  const [template, setTemplate] = useState<FolderNoteTemplate | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let cancelled = false;
    void api.folderNoteTemplate(folder.id).then((value) => {
      if (cancelled) return;
      setTemplate(value); setMarkdown(value.own ?? value.effective?.markdown ?? "");
    }, onError);
    return () => { cancelled = true; };
  }, [api, folder.id, onError]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, busy]);
  const save = async (inherit: boolean) => {
    setBusy(true);
    try {
      await api.saveFolderNoteTemplate(folder.id, inherit ? null : markdown);
      onSaved(); onClose();
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <div className="stage-dialog template-dialog" role="dialog" aria-modal="true" aria-label="폴더 노트 템플릿">
      <header className="template-head"><h2>{folder.name} · 노트 템플릿</h2><button type="button" className="icon-button small" disabled={busy} onClick={onClose} aria-label="닫기"><Icon name="x" size={15} /></button></header>
      <p className="sheet-hint">이 분류와 하위 폴더에서 새 프로젝트 노트를 만들 때 복사할 내용입니다. 속성(YAML)과 본문을 함께 작성할 수 있습니다. 기존 노트는 그대로 유지됩니다.</p>
      {template?.own === null ? <p className="sheet-hint">{template.effective ? `현재 「${template.effective.folderName}」의 템플릿을 따릅니다.` : "현재 별도 노트 템플릿이 없습니다."}</p> : null}
      <textarea className="sheet-input folder-template-source" aria-label="노트 템플릿 마크다운" value={markdown} onChange={(event) => setMarkdown(event.target.value)} disabled={!template || busy} spellCheck={false} placeholder={'---\n종류: 강의\n마감일:\n---\n# 목표\n\n## 준비할 것\n- [ ] '} />
      <div className="template-tools"><button type="button" className="ghost-button small" disabled={busy} onClick={() => file.current?.click()}><Icon name="download" size={13} /> MD 파일에서 가져오기</button>
        <input type="file" accept=".md,.markdown,text/markdown,text/plain" ref={file} hidden onChange={(event) => {
          const picked = event.target.files?.[0];
          if (picked) void picked.text().then(setMarkdown, onError);
          event.target.value = "";
        }} />
      </div>
      <div className="stage-foot">
        <button type="button" className="button small" disabled={busy || !template} onClick={() => void save(true)}>상위 템플릿 따르기</button><span className="stage-spacer" />
        <button type="button" className="button small" disabled={busy} onClick={onClose}>그만두기</button>
        <button type="button" className="button small primary" disabled={busy || !template} onClick={() => void save(false)}>이 폴더에 저장</button>
      </div>
    </div>
  </div>;
}

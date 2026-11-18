import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Api, ConvertOptions, Converted, HangulChoices, ImportedFile } from "../../api.ts";
import { ApiRequestError } from "../../api.ts";
import { Select } from "../ui/Select.tsx";
import { Icon } from "../Icon.tsx";
import { restoreSurfaceFocus } from "../controls/menu-navigation.ts";
import "../../styles/hangul-convert.css";

/**
 * 불러오기 (hangul-convert.ts, the HanMark way): HanMark's four presets, 쪽 범위, 그림 저장, and a password
 * asked when a file needs one (kept in this dialog's memory only, three tries). Each file becomes a NEW
 * `{stem}.md` beside it; the original is never changed. One file converted cleanly: the new document
 * just opens. Otherwise a short report: tables, pictures, warnings with their pages.
 */
export type ImportTarget = { workId: string; files: ImportedFile[] };
type Row = { file: ImportedFile; state: "waiting" | "password" | "working" | "done" | "failed" | "skipped"; result?: Converted; error?: string; tries: number };

export const PASSWORD_TRIES = 3;
const isPdf = (name: string) => /\.pdf$/i.test(name);

export function HangulImportDialog({ api, target, onOpen, onClose }: { api: Api; target: ImportTarget; onOpen(artifactId: string): void; onClose(): void }) {
  const [choices, setChoices] = useState<HangulChoices | null>(null);
  const [preset, setPreset] = useState("default"), [pages, setPages] = useState(""), [images, setImages] = useState(true);
  const [rows, setRows] = useState<Row[]>(() => target.files.map((file) => ({ file, state: "waiting", tries: 0 })));
  const [password, setPassword] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  const passwordField = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => () => restoreSurfaceFocus(opener.current, null), []);
  useEffect(() => { void api.hangulChoices().then(setChoices, (reason: Error) => setError(reason.message)); }, [api]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [busy, onClose]);
  const asking = rows.find((row) => row.state === "password");
  useEffect(() => { if (asking) passwordField.current?.focus(); }, [asking]);
  const finished = rows.length > 0 && rows.every((row) => row.state === "done" || row.state === "failed" || row.state === "skipped");
  const single = target.files.length === 1 ? target.files[0] : null;
  const pdfLine = choices && !choices.pdf && rows.some((row) => isPdf(row.file.name)) ? choices.pdfLine : null;

  /** One file, one attempt; a password refusal keeps the row waiting for the password (memory only). */
  const convertOne = async (row: Row, secret?: string): Promise<Row> => {
    const options: ConvertOptions = { preset, pages, images, ...(secret ? { password: secret } : {}) };
    try {
      const result = await api.convertToMarkdown(row.file.artifactId ? { artifactId: row.file.artifactId } : { workId: target.workId, path: row.file.path }, options);
      return { ...row, state: "done", result, error: undefined };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const tries = row.tries + (secret ? 1 : 0);
      if (reason instanceof ApiRequestError && reason.passwordHelps) {
        if (tries >= PASSWORD_TRIES) return { ...row, state: "failed", tries, error: `암호가 ${PASSWORD_TRIES}번 맞지 않아 이 파일은 멈췄습니다. 암호를 확인한 뒤 다시 불러오세요.` };
        return { ...row, state: "password", tries, error: secret ? `${message} (남은 횟수 ${PASSWORD_TRIES - tries}번)` : message };
      }
      return { ...row, state: "failed", tries, error: message };
    }
  };
  const run = async (from: Row[], secret?: string) => {
    setBusy(true); setError("");
    const next = [...from];
    for (let index = 0; index < next.length; index++) {
      const row = next[index];
      const retry = row.state === "password" && secret !== undefined;
      if (row.state !== "waiting" && !retry) continue;
      if (choices && !choices.pdf && isPdf(row.file.name)) { next[index] = { ...row, state: "skipped", error: choices.pdfLine }; setRows([...next]); continue; }
      next[index] = { ...row, state: "working" }; setRows([...next]);
      next[index] = await convertOne(row, retry ? secret : undefined);
      setRows([...next]);
      // One file at a time; a password question stops the queue until it is answered.
      if (next[index].state === "password") break;
    }
    setPassword("");
    setBusy(false);
    const done = next.filter((row) => row.state === "done");
    // A clean single import just opens the new document.
    if (target.files.length === 1 && done.length === 1 && !done[0].result!.warnings.length) { onOpen(done[0].result!.artifact.id); onClose(); }
  };

  const presetOption = choices?.presets.find((entry) => entry.id === preset);
  const title = single ? `「${single.name}」 Markdown 문서로 변환` : `문서 ${target.files.length}개 Markdown 문서로 변환`;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <form className="stage-dialog hconv-dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      if (asking) { if (password) void run(rows, password); return; }
      if (finished) { onClose(); return; }
      void run(rows);
    }}>
      <header className="template-head"><h2>{title}</h2></header>
      <p className="sheet-hint">원본은 그대로 두고 같은 폴더에 Markdown 문서를 새로 만듭니다. 그림은 「이름.assets」 폴더에 파일로 저장합니다.</p>
      {!single && !finished ? <ul className="hconv-files" aria-label="불러올 파일">{rows.map((row) => <li key={row.file.path}><Icon name="file" size={16} /><span className="hconv-file-name">{row.file.name}</span><span className="hconv-file-state">{stateWord(row)}</span></li>)}</ul> : null}
      {!finished && !asking ? <>
        <label className="hconv-field">미리 정한 방식
          <Select label="미리 정한 방식" value={preset} disabled={busy || !choices} onChange={setPreset} options={(choices?.presets ?? []).map((entry) => ({ value: entry.id, label: entry.label }))} />
        </label>
        {presetOption ? <p className="hconv-desc">{presetOption.description}</p> : null}
        <label className="hconv-field">쪽 범위
          <input className="sheet-input" value={pages} disabled={busy} placeholder="비우면 전체 (예: 1-3,5)" aria-label="쪽 범위" onChange={(event) => setPages(event.target.value)} />
        </label>
        <label className="hconv-check"><input type="checkbox" checked={images && preset !== "text"} disabled={busy || preset === "text"} onChange={(event) => setImages(event.target.checked)} /> 그림을 파일로 저장</label>
      </> : null}
      {pdfLine ? <p className="hconv-line">{pdfLine}</p> : null}
      {asking ? <div className="hconv-password">
        <label className="hconv-field">{`「${asking.file.name}」 암호`}
          <input ref={passwordField} className="sheet-input" type="password" autoComplete="off" value={password} disabled={busy} aria-label="문서 암호" aria-describedby="hconv-password-note" onChange={(event) => setPassword(event.target.value)} />
        </label>
        <p id="hconv-password-note" className="hconv-desc hconv-password-note">{asking.error}{/저장하지 않습니다/.test(asking.error ?? "") ? "" : " 암호는 저장하지 않습니다."}</p>
      </div> : null}
      {finished ? <ul className="hconv-report" aria-label="변환 결과">{rows.map((row) => <li key={row.file.path}>
        {row.result ? <>
          <div className="hconv-report-head"><span className="hconv-file-name">{row.result.artifact.name}</span><button type="button" className="button small" onClick={() => { onOpen(row.result!.artifact.id); onClose(); }}>열기</button></div>
          <p className="hconv-desc">{`표 ${row.result.tables}개, 그림 ${row.result.pictures}개${row.result.warnings.length ? `, 확인할 점 ${row.result.warnings.length}가지` : ""}`}</p>
          {row.result.warnings.length ? <ul className="hconv-warnings">{row.result.warnings.slice(0, 8).map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
        </> : <><div className="hconv-report-head"><span className="hconv-file-name">{row.file.name}</span></div><p className="hconv-desc" role="alert">{row.error}</p></>}
      </li>)}</ul> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer className="stage-foot"><span className="stage-spacer" />
        {finished ? <button type="submit" className="button small primary">닫기</button> : <>
          <button type="button" className="button small" disabled={busy} onClick={() => asking ? void run(rows.map((row) => row === asking ? { ...row, state: "skipped", error: "암호를 넣지 않아 건너뛰었습니다. 원본은 그대로입니다." } : row)) : onClose()}>{asking ? "건너뛰기" : "취소"}</button>
          <button type="submit" className="button small primary" disabled={busy || !choices || (Boolean(asking) && !password)}>{busy ? "변환 중…" : asking ? "암호로 열기" : "변환"}</button>
        </>}
      </footer>
    </form>
  </div>;
}

function stateWord(row: Row) {
  return row.state === "done" ? "완료" : row.state === "failed" ? "실패" : row.state === "skipped" ? "건너뜀" : row.state === "working" ? "진행 중" : row.state === "password" ? "암호 필요" : "";
}

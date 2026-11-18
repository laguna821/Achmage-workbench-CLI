import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Artifact } from "@workbench/contracts";
import type { Api, ExportedHangul, HangulChoices, WordHangulPlan } from "../../api.ts";
import { Select } from "../ui/Select.tsx";
import { restoreSurfaceFocus } from "../controls/menu-navigation.ts";
import "../../styles/hangul-convert.css";

/**
 * 내보내기 (hangul-convert.ts): a Markdown document → a NEW HWPX (default), HWP or DOCX beside it, never
 * over a file. The template chooser is HanMark's: 기본, 한국언론학회, 청소년학, the person's own templates
 * ("HWPX를 양식으로 등록…": the core's template-analyze, kept in the app's data folder) and the 공문서 types.
 */
type Format = "hwpx" | "hwp" | "docx";
const FORMATS: { value: Format; label: string }[] = [{ value: "hwpx", label: "한글 HWPX (권장)" }, { value: "hwp", label: "한글 HWP" }, { value: "docx", label: "워드 DOCX" }];
/** 공문서 types with a cover date (frozen, so the same input gives the same file). */
const DATED = new Set(["gongmun:gaejosik", "gongmun:ministry"]);
export const todayDot = (now = new Date()) => `${now.getFullYear()}. ${now.getMonth() + 1}. ${now.getDate()}.`;

/**
 * The same dialog for a Word document (워드 문서 → 한글, IeumOffice's docx2hwp on the one Hangul engine): the Word
 * document's own look is carried, so there is no 서식 to choose; BEFORE anything is written the dialog shows what the
 * copy loses (upstream's ledger, its own words) and asks; a .hwp is made only when it reads back with the same pages.
 * `editor`: the Word editor's own menu item sends its document as it is open.
 */
export function HangulExportDialog({ api, artifact, editor, onOpen, onDone, onClose }: { api: Api; artifact: Artifact; editor?: { bytes: ArrayBuffer; passwordSet: boolean }; onOpen(artifactId: string): void; /** The new document is made (before 열기/닫기). */ onDone?(made: Artifact): void; onClose(): void }) {
  return artifact.format === "docx"
    ? <WordToHangul api={api} artifact={artifact} editor={editor} onOpen={onOpen} onDone={onDone} onClose={onClose} />
    : <MarkdownToHangul api={api} artifact={artifact} onOpen={onOpen} onDone={onDone} onClose={onClose} />;
}

type WordFormat = "hwpx" | "hwp";
const WORD_FORMATS: { value: WordFormat; label: string }[] = [{ value: "hwpx", label: "한글 HWPX (권장)" }, { value: "hwp", label: "한글 HWP" }];

function WordToHangul({ api, artifact, editor, onOpen, onDone, onClose }: { api: Api; artifact: Artifact; editor?: { bytes: ArrayBuffer; passwordSet: boolean }; onOpen(artifactId: string): void; onDone?(made: Artifact): void; onClose(): void }) {
  const [format, setFormat] = useState<WordFormat>("hwpx"), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [plan, setPlan] = useState<WordHangulPlan | null>(null), [done, setDone] = useState<Artifact | null>(null);
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useLayoutEffect(() => () => restoreSurfaceFocus(opener.current, null), []);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [busy, onClose]);
  const stem = artifact.name.replace(/\.docx$/i, "");
  const run = async (step: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await step(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  const made = (created: Artifact) => { setDone(created); onDone?.(created); };
  const commit = (ticket: string) => run(async () => { made((await api.commitWordHangul(artifact.id, ticket)).artifact); setPlan(null); });
  const convert = () => run(async () => {
    const prepared = await api.prepareWordHangul(artifact.id, { format, ...(name.trim() ? { name: name.trim() } : {}), ...(editor?.passwordSet ? { passwordSet: true } : {}) }, editor?.bytes);
    // Nothing lost: nothing to ask; the file is written at once.
    if (!prepared.ledger.sections.length) { made((await api.commitWordHangul(artifact.id, prepared.ticket)).artifact); return; }
    setPlan(prepared);
  });
  const submit = () => { if (busy) return; if (done) onClose(); else if (plan) void commit(plan.ticket); else void convert(); };

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <form className="stage-dialog hconv-dialog" role="dialog" aria-modal="true" aria-label="한글 문서로 내보내기" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <header className="template-head"><h2>한글 문서로 내보내기</h2></header>
      <p className="sheet-hint">{`「${artifact.name}」에서 새 한글 문서를 같은 폴더에 만듭니다. 워드 문서와 다른 파일은 바뀌지 않습니다.`}</p>
      {done ? <div className="hconv-report" role="status">
        <div className="hconv-report-head"><span className="hconv-file-name">{done.name}</span><button type="button" className="button small" onClick={() => { onOpen(done.id); onClose(); }}>열기</button></div>
        <p className="hconv-desc">{`「${done.name}」을(를) 만들었습니다. 워드 문서의 쪽 설정·머리말·표·그림을 옮겼습니다.`}</p>
      </div> : plan ? <div className="hconv-ledger" role="group" aria-label={plan.ledger.message}>
        <p className="hconv-line">{plan.ledger.message}</p>
        {plan.ledger.sections.map((section) => <section key={section.heading} className="hconv-ledger-part">
          <h3>{section.heading}</h3>
          <ul className="hconv-warnings">{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>)}
        <p className="hconv-desc">{`저장하면 「${plan.name}」을(를) 만듭니다.`}</p>
      </div> : <>
        <label className="hconv-field">형식
          <Select<WordFormat> label="형식" value={format} disabled={busy} onChange={setFormat} options={WORD_FORMATS} />
        </label>
        <p className="hconv-desc">{format === "hwp"
          ? "워드 문서의 모양을 그대로 옮깁니다. HWP는 다시 읽어 쪽 수가 같을 때만 만듭니다. 옮기지 못하는 것은 만들기 전에 알려 드립니다."
          : "워드 문서의 모양을 그대로 옮깁니다. 옮기지 못하는 것은 만들기 전에 알려 드립니다."}</p>
        {editor ? <p className="hconv-desc">편집기에 열린 내용(저장하지 않은 편집 포함)으로 만듭니다.</p> : null}
        <label className="hconv-field">새 문서 이름
          <input className="sheet-input" value={name} disabled={busy} aria-label="새 문서 이름" placeholder={`${stem}.${format} (같은 이름이 있으면 번호를 붙입니다)`} onChange={(event) => setName(event.target.value)} />
        </label>
      </>}
      {error ? <p role="alert">{error}</p> : null}
      <footer className="stage-foot"><span className="stage-spacer" />
        {done ? <button type="submit" className="button small primary">닫기</button> : <>
          <button type="button" className="button small" disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" className="button small primary" disabled={busy}>{busy ? "만드는 중…" : plan ? "저장" : "내보내기"}</button>
        </>}
      </footer>
    </form>
  </div>;
}

function MarkdownToHangul({ api, artifact, onOpen, onDone, onClose }: { api: Api; artifact: Artifact; onOpen(artifactId: string): void; onDone?(made: Artifact): void; onClose(): void }) {
  const [choices, setChoices] = useState<HangulChoices | null>(null);
  const [format, setFormat] = useState<Format>("hwpx"), [template, setTemplate] = useState<string | null>(null);
  const [name, setName] = useState(""), [date, setDate] = useState(() => todayDot());
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [done, setDone] = useState<ExportedHangul | null>(null);
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useLayoutEffect(() => () => restoreSurfaceFocus(opener.current, null), []);
  useEffect(() => { void api.hangulChoices().then((value) => { setChoices(value); setTemplate((current) => current ?? value.defaultTemplate); }, (reason: Error) => setError(reason.message)); }, [api]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [busy, onClose]);
  const stem = artifact.name.replace(/\.(md|markdown)$/i, "");
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  const register = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: false, multiple: false, title: "양식으로 등록할 HWPX", filters: [{ name: "한글 HWPX", extensions: ["hwpx"] }] });
    if (typeof picked !== "string") return;
    setBusy(true); setError("");
    try {
      const before = new Set(choices?.templates.map((entry) => entry.id));
      const next = await api.registerHangulTemplate(picked);
      setChoices(next);
      const added = next.templates.find((entry) => entry.group === "내 양식" && !before.has(entry.id));
      if (added) setTemplate(added.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!template) return;
    setBusy(true); setError("");
    try {
      const exported = await api.exportHangul(artifact.id, { format, template, ...(name.trim() ? { name: name.trim() } : {}), ...(DATED.has(template) ? { date } : {}) });
      setDone(exported); onDone?.(exported.artifact);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
    <form className="stage-dialog hconv-dialog" role="dialog" aria-modal="true" aria-label="한글 문서로 내보내기" onSubmit={(event) => { event.preventDefault(); if (done) onClose(); else if (!busy) void save(); }}>
      <header className="template-head"><h2>한글 문서로 내보내기</h2></header>
      <p className="sheet-hint">{`「${artifact.name}」에서 새 문서를 같은 폴더에 만듭니다. 원래 문서와 다른 파일은 바뀌지 않습니다.`}</p>
      {done ? <div className="hconv-report" role="status">
        <div className="hconv-report-head"><span className="hconv-file-name">{done.artifact.name}</span><button type="button" className="button small" onClick={() => { onOpen(done.artifact.id); onClose(); }}>열기</button></div>
        <p className="hconv-desc">{`${done.template} 서식으로 만들었습니다.${done.warnings.length ? ` 확인할 점 ${done.warnings.length}가지가 있습니다.` : ""}`}</p>
        {done.warnings.length ? <ul className="hconv-warnings">{done.warnings.slice(0, 8).map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
      </div> : <>
        <label className="hconv-field">형식
          <Select<Format> label="형식" value={format} disabled={busy} onChange={setFormat} options={FORMATS} />
        </label>
        {format !== "docx" ? <>
          <label className="hconv-field">서식
            <Select label="서식" value={template} disabled={busy || !choices} onChange={setTemplate} searchable
              options={(choices?.templates ?? []).map((entry) => ({ value: entry.id, label: entry.label, group: entry.group }))}
              actions={desktop ? [{ key: "register", label: "HWPX를 양식으로 등록…", icon: "plus", onSelect: () => void register() }] : []} />
          </label>
          {template && DATED.has(template) ? <label className="hconv-field">표지 날짜
            <input className="sheet-input" value={date} disabled={busy} aria-label="표지 날짜" onChange={(event) => setDate(event.target.value)} />
          </label> : null}
        </> : <p className="hconv-desc">워드 문서는 이음오피스가 Markdown 그대로 만듭니다. 서식은 고르지 않습니다.</p>}
        <label className="hconv-field">새 문서 이름
          <input className="sheet-input" value={name} disabled={busy} aria-label="새 문서 이름" placeholder={`${stem}.${format} (같은 이름이 있으면 번호를 붙입니다)`} onChange={(event) => setName(event.target.value)} />
        </label>
      </>}
      {error ? <p role="alert">{error}</p> : null}
      <footer className="stage-foot"><span className="stage-spacer" />
        {done ? <button type="submit" className="button small primary">닫기</button> : <>
          <button type="button" className="button small" disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" className="button small primary" disabled={busy || !template}>{busy ? "만드는 중…" : "내보내기"}</button>
        </>}
      </footer>
    </form>
  </div>;
}

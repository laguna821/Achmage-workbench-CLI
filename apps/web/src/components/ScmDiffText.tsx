import { useCallback, useEffect, useRef, useState } from "react";
import type { ScmDiff } from "@workbench/contracts";

export function ScmDiffText({ diff, busy, onHunks }: { diff: ScmDiff; busy: boolean; onHunks: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]), container = useRef<HTMLDivElement>(null);
  useEffect(() => setSelected([]), [diff.revision]);
  const nextHunk = useCallback((backwards = false) => {
    const elements = [...(container.current?.querySelectorAll<HTMLElement>(".scm-line.hunk") ?? [])];
    const at = elements.findIndex((element) => element.contains(document.activeElement));
    const next = elements[at < 0 ? backwards ? elements.length - 1 : 0 : (at + (backwards ? -1 : 1) + elements.length) % elements.length]; next?.focus(); next?.scrollIntoView({ block: "center" });
  }, []);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "F7") { event.preventDefault(); event.stopPropagation(); nextHunk(event.shiftKey); } }; window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true); }, [nextHunk]);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  let oldLine = 0, newLine = 0, oldLeft = 0, newLeft = 0, inHunk = false;
  const label = diff.area === "working" ? "스테이징" : "스테이징 취소";
  return <div ref={container} className="scm-diff-text">
    {diff.hunks?.length ? <div className="scm-hunk-tools"><span>변경 구간 {diff.hunks.length}개 · 선택 {selected.length}개</span><button className="button small scm-selected-hunks" disabled={busy || !selected.length} onClick={() => onHunks(selected)}>선택 구간 {label}</button><button className="text-button" disabled={busy} onClick={() => setSelected(selected.length === diff.hunks!.length ? [] : diff.hunks!.map((hunk) => hunk.id))}>{selected.length === diff.hunks.length ? "선택 해제" : "모든 구간 선택"}</button><button className="text-button" onClick={() => nextHunk()}>다음 변경 · F7</button></div> : diff.partialReason ? <p className="scm-warning">{diff.partialReason}</p> : null}
    <div className="scm-lines" role="table" aria-label="파일 변경 비교">{(diff.patch || "이 영역의 변경이 없습니다.").split("\n").map((text, i) => {
      const match = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/), hunk = diff.hunks?.find((entry) => entry.patchLine === i);
      if (match) { oldLine = Number(match[1]); oldLeft = Number(match[2] ?? 1); newLine = Number(match[3]); newLeft = Number(match[4] ?? 1); inHunk = true; }
      const kind = match ? "hunk" : inHunk && text.startsWith("+") ? "add" : inHunk && text.startsWith("-") ? "del" : "context";
      const numbered = inHunk && !match && /^[ +\-]/.test(text), before = numbered && kind !== "add" ? oldLine++ : "", after = numbered && kind !== "del" ? newLine++ : "";
      if (numbered) { if (kind !== "add") oldLeft--; if (kind !== "del") newLeft--; if (oldLeft <= 0 && newLeft <= 0) inHunk = false; }
      return <div role="row" className={`scm-line ${kind}`} tabIndex={match ? -1 : undefined} key={i} data-hunk-id={hunk?.id}><span role="cell" className="scm-line-number">{before}</span><span role="cell" className="scm-line-number">{after}</span><code role="cell">{text || " "}</code>{hunk ? <span role="cell" className="scm-hunk-action"><label><input type="checkbox" className="scm-hunk-select" aria-label={`변경 구간 ${hunk.oldStart}행 선택`} checked={selected.includes(hunk.id)} disabled={busy} onChange={() => toggle(hunk.id)} />선택</label><button className="text-button scm-one-hunk" disabled={busy} onClick={() => onHunks([hunk.id])}>이 구간 {label}</button></span> : null}</div>;
    })}</div>
  </div>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { scmPatchRows, type ScmComparisonDiff, type ScmDiff } from "@workbench/contracts";
import { useScmReviews } from "./ScmReviewNotes.tsx";

export function ScmDiffText({ diff, busy = false, onHunks }: { diff: ScmDiff | (ScmComparisonDiff & { area?: never; hunks?: never; partialReason?: never }); busy?: boolean; onHunks?: (ids: string[]) => void }) {
  const reviews = useScmReviews();
  useEffect(() => { reviews?.setView(diff.review ? { path: diff.path, snapshot: diff.review } : null); return () => reviews?.setView(null); }, [diff.review?.id, diff.path, reviews?.setView]);
  const [selected, setSelected] = useState<string[]>([]), container = useRef<HTMLDivElement>(null);
  useEffect(() => setSelected([]), [diff.revision]);
  const nextHunk = useCallback((backwards = false) => {
    const elements = [...(container.current?.querySelectorAll<HTMLElement>(".scm-line.hunk") ?? [])];
    const at = elements.findIndex((element) => element.contains(document.activeElement));
    const next = elements[at < 0 ? backwards ? elements.length - 1 : 0 : (at + (backwards ? -1 : 1) + elements.length) % elements.length]; next?.focus(); next?.scrollIntoView({ block: "center" });
  }, []);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "F7") { event.preventDefault(); event.stopPropagation(); nextHunk(event.shiftKey); } }; window.addEventListener("keydown", key, true); return () => window.removeEventListener("keydown", key, true); }, [nextHunk]);
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const parsed = scmPatchRows(diff.patch || "이 영역의 변경이 없습니다.");
  const annotate = (side: "before" | "after", line: number) => { if (diff.review?.lines) reviews?.begin({ path: diff.path, snapshot: diff.review }, { side, start: line, end: line }); };
  const label = diff.area === "working" ? "스테이징" : "스테이징 취소";
  return <div ref={container} className="scm-diff-text">
    {diff.hunks?.length && onHunks ? <div className="scm-hunk-tools"><span>변경 구간 {diff.hunks.length}개 · 선택 {selected.length}개</span><button className="button small scm-selected-hunks" disabled={busy || !selected.length} onClick={() => onHunks(selected)}>선택 구간 {label}</button><button className="text-button" disabled={busy} onClick={() => setSelected(selected.length === diff.hunks!.length ? [] : diff.hunks!.map((hunk) => hunk.id))}>{selected.length === diff.hunks.length ? "선택 해제" : "모든 구간 선택"}</button><button className="text-button" onClick={() => nextHunk()}>다음 변경 · F7</button></div> : diff.partialReason ? <p className="scm-warning">{diff.partialReason}</p> : <div className="scm-hunk-tools"><button className="text-button" onClick={() => nextHunk()}>다음 변경 · F7</button></div>}
    {diff.review?.reason ? <p className="scm-warning">{diff.review.reason}</p> : null}
    <div className="scm-lines" role="table" aria-label="파일 변경 비교">{parsed.rows.map(({ text, kind, before, after }, i) => {
      const hunk = diff.hunks?.find((entry) => entry.patchLine === i), line = after ?? before;
      const pins = reviews?.data?.notes.filter((note) => { const place = reviews.data?.placements[note.id]; return !note.resolved && ["same", "moved"].includes(place?.kind ?? "") && place?.start === (note.anchor.selection?.side === "before" ? before : after); }) ?? [];
      const cell = (side: "before" | "after", number?: number) => <span role="cell" className="scm-line-number">{number && diff.review?.lines && reviews ? <button className="scm-line-comment" data-side={side} data-line={number} title={`${side === "before" ? "이전" : "이후"} ${number}행 의견 추가 · C`} aria-label={`${side === "before" ? "이전" : "이후"} ${number}행 의견 추가`} onClick={() => annotate(side, number)}>{number}<span aria-hidden="true">+</span></button> : number ?? ""}</span>;
      return <div role="row" className={`scm-line ${kind}`} tabIndex={-1} key={i} data-hunk-id={hunk?.id} data-before={before} data-after={after} onMouseDown={(event) => { if (event.target instanceof HTMLElement && event.target.tagName === "CODE") event.currentTarget.focus(); }} onKeyDown={(event) => { if (event.key.toLowerCase() === "c" && !event.ctrlKey && !event.metaKey && !event.altKey && line) { event.preventDefault(); annotate(after ? "after" : "before", line); } }}>
        {cell("before", before)}{cell("after", after)}<code role="cell">{text || " "}</code>{pins.length ? <button className="scm-line-note-count text-button" title="이 위치의 미해결 의견" onClick={() => reviews?.show()}>의견 {pins.length}</button> : null}{hunk && onHunks ? <span role="cell" className="scm-hunk-action"><label><input type="checkbox" className="scm-hunk-select" aria-label={`변경 구간 ${hunk.oldStart}행 선택`} checked={selected.includes(hunk.id)} disabled={busy} onChange={() => toggle(hunk.id)} />선택</label><button className="text-button scm-one-hunk" disabled={busy} onClick={() => onHunks([hunk.id])}>이 구간 {label}</button></span> : null}
      </div>;
    })}</div>
  </div>;
}

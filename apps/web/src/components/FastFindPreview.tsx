import { useEffect, useMemo, useRef } from "react";
import type { SearchPreview } from "@workbench/contracts";
import { classifyLines, queryTerms, segmentLine } from "../../../../third_party/fast-find/adapter/ui.ts";

/** Upstream's bounded plain-text preview: headings, code, wiki links and tags, without an
 * Obsidian runtime or rendering arbitrary document HTML. Only the selected source is loaded. */
export function FastFindPreview({ value, query }: { value: SearchPreview; query: string }) {
  const root = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => {
    const terms = queryTerms(query), budget = { marks: 200, styles: 2000 };
    return classifyLines((value.text ?? "").split("\n")).map((line, index) => ({ ...line,
      number: (value.startLine ?? 0) + index,
      segments: segmentLine(line.text, terms, budget, line.kind === "code"),
    }));
  }, [value, query]);
  useEffect(() => { root.current?.querySelector(".search-source-target")?.scrollIntoView({ block: "center" }); }, [value]);
  if (!value.found) return <div className="muted">항목이 이동·삭제되었거나 현재 범위에서 숨겨졌습니다.</div>;
  return <div className="search-source" ref={root} aria-label="선택 결과 본문">
    {value.startLine ? <div className="search-source-bound">… 앞부분 {value.startLine}줄</div> : null}
    {lines.map(line => <div key={line.number} className={`search-source-line search-source-${line.kind}${line.number === value.targetLine ? " search-source-target" : ""}`}>
      <span className="search-source-number" aria-hidden="true">{line.number + 1}</span>
      <span>{line.segments.length ? line.segments.map((part, i) => part.mark
        ? <mark key={i} className={part.style ? `search-source-${part.style}` : undefined}>{part.text}</mark>
        : <span key={i} className={part.style ? `search-source-${part.style}` : undefined}>{part.text}</span>) : "\u00a0"}</span>
    </div>)}
    {value.truncated && <div className="search-source-bound">전체 {value.totalLines}줄 · 일치 위치 주변을 표시합니다. 전체 내용은 열어서 확인하세요.</div>}
  </div>;
}

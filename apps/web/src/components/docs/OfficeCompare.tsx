import { useMemo, useState } from "react";
import { useOfficePage, useOfficePages, type PageSource } from "../../office.ts";
import { DiffView } from "./DiffView.tsx";

function Side({ source, page, label }: { source: PageSource; page: number; label: string }) {
  const image = useOfficePage(source, page);
  return (
    <figure className="design-thumb-figure">
      <figcaption>{label}</figcaption>
      {image.url ? <img src={image.url} alt={`${label} ${page}쪽`} /> : <div className="design-thumb-wait">{image.error ?? "그리는 중…"}</div>}
    </figure>
  );
}

/** A Word/PowerPoint/Excel proposal: base and proposed pages side by side, or the text difference. */
export function OfficeCompare({
  proposalId,
  before,
  after,
  beforeLabel,
  afterLabel,
}: {
  proposalId: string;
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
}) {
  const base = useMemo<PageSource>(() => ({ proposalId, side: "base" }), [proposalId]);
  const proposed = useMemo<PageSource>(() => ({ proposalId, side: "proposed" }), [proposalId]);
  const basePages = useOfficePages(base);
  const proposedPages = useOfficePages(proposed);
  const [view, setView] = useState<"pages" | "text">("pages");
  const [page, setPage] = useState(1);
  const count = Math.max(basePages.pages?.length ?? 0, proposedPages.pages?.length ?? 0);
  return (
    <div className="design-compare">
      <div className="office-compare-bar">
        <div className="segmented small" role="radiogroup" aria-label="비교 방식">
          {(["pages", "text"] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={view === value} className={view === value ? "active" : ""} onClick={() => setView(value)}>
              {value === "pages" ? "쪽 그림" : "글 차이"}
            </button>
          ))}
        </div>
        {view === "pages" && count > 1 ? (
          <div className="segmented small" role="radiogroup" aria-label="쪽">
            {Array.from({ length: count }, (_, index) => index + 1).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={page === value} className={page === value ? "active" : ""} onClick={() => setPage(value)}>
                {value}
              </button>
            ))}
          </div>
        ) : null}
        {basePages.pages && proposedPages.pages && basePages.pages.length !== proposedPages.pages.length ? (
          <span className="muted">
            {basePages.pages.length}쪽 → {proposedPages.pages.length}쪽
          </span>
        ) : null}
      </div>
      {view === "pages" ? (
        basePages.error || proposedPages.error ? (
          <div className="column empty-hint">{basePages.error ?? proposedPages.error}</div>
        ) : (
          <div className="design-compare-pair">
            <Side source={base} page={Math.min(page, basePages.pages?.length ?? page)} label={beforeLabel} />
            <Side source={proposed} page={Math.min(page, proposedPages.pages?.length ?? page)} label={afterLabel} />
          </div>
        )
      ) : (
        <DiffView before={before} after={after} beforeLabel={beforeLabel} afterLabel={afterLabel} />
      )}
    </div>
  );
}

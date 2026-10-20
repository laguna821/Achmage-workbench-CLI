import { useMemo, useState } from "react";
import { changeKindLabel, designChanges, firstChangedPage, useDesignThumb, type ThumbSource } from "../../design.ts";

function Thumb({ source, page, width, label }: { source: ThumbSource; page: number; width: number; label: string }) {
  const thumb = useDesignThumb(source, page, width);
  return (
    <figure className="design-thumb-figure">
      <figcaption>{label}</figcaption>
      {thumb.url ? <img src={thumb.url} alt={`${label} ${page + 1}쪽`} /> : <div className="design-thumb-wait">{thumb.error ?? "그리는 중…"}</div>}
    </figure>
  );
}

/** Two versions of a design side by side, page by page, with what changed object by object. */
export function DesignCompare({
  before,
  after,
  beforeText,
  afterText,
  beforeLabel,
  afterLabel,
}: {
  before: ThumbSource;
  after: ThumbSource;
  beforeText: string;
  afterText: string;
  beforeLabel: string;
  afterLabel: string;
}) {
  const changes = useMemo(() => designChanges(beforeText, afterText), [beforeText, afterText]);
  const pages = useMemo(() => [...new Set((changes ?? []).map((change) => change.page))].sort((a, b) => a - b), [changes]);
  const [page, setPage] = useState(() => firstChangedPage(changes));
  if (!changes) return <div className="column empty-hint">디자인 파일을 읽지 못해 비교할 수 없습니다 (JSON 오류).</div>;
  return (
    <div className="design-compare">
      {pages.length > 1 ? (
        <div className="segmented small design-compare-pages" role="radiogroup" aria-label="페이지">
          {pages.map((value) => (
            <button key={value} type="button" role="radio" aria-checked={page === value} className={page === value ? "active" : ""} onClick={() => setPage(value)}>
              {value + 1}쪽
            </button>
          ))}
        </div>
      ) : null}
      <div className="design-compare-pair">
        <Thumb source={before} page={page} width={560} label={beforeLabel} />
        <Thumb source={after} page={page} width={560} label={afterLabel} />
      </div>
      <ul className="design-changes">
        {changes.length === 0 ? <li className="muted">바뀐 개체가 없습니다.</li> : null}
        {changes.map((change, index) => (
          <li key={index} className={`design-change kind-${change.kind}${change.page === page ? " current" : ""}`}>
            <span className="design-change-kind">{changeKindLabel(change.kind)}</span>
            <span className="design-change-label">
              {change.page + 1}쪽 · {change.label}
            </span>
            {change.detail ? <span className="design-change-detail">{change.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useEffect, useState } from "react";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";

type Page = { page: number; width: number; height: number; svg: string };

/**
 * Saved Hangul pages rendered by the same Ieum rhwp engine as the document editor.
 * Shown as images (never inline SVG), so document content cannot run anything in the app.
 */
export function HwpxView({ api, artifact, revision }: { api: Api; artifact: Artifact; revision: number }) {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setError(null);
    api
      .pages(artifact.id, revision)
      .then((result) => {
        // A preview of an older revision never replaces the newer one.
        if (!cancelled && result.revision === revision) setPages(result.pages);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [api, artifact.id, revision]);

  return (
    <div className="hwpx-view">
      <div className="doc-tools">
        <span className="muted">
          {pages ? `${pages.length}쪽 · r${revision}` : error ? "미리보기 없음" : "쪽 그리는 중…"} · 이음 한글
        </span>
      </div>
      <div className="hwpx-stage">
        {error ? <div className="notice notice-error">{error}</div> : null}
        {pages?.map((page) => (
          <img
            key={`${revision}:${page.page}`}
            className="hwpx-page"
            alt={`${page.page}쪽`}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(page.svg)}`}
            style={{ aspectRatio: `${page.width} / ${page.height}` }}
          />
        ))}
      </div>
    </div>
  );
}

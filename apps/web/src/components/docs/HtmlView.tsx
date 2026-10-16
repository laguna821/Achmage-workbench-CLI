import { useEffect, useState } from "react";
import type { Api } from "../../api.ts";

const WIDTHS = [
  { id: "phone", label: "휴대폰", width: 390 },
  { id: "tablet", label: "태블릿", width: 820 },
  { id: "wide", label: "넓게", width: 0 },
] as const;

/**
 * The real page, rendered by the browser engine (never a generated image). It runs as an opaque
 * origin with its own ticket URL, so it cannot reach the app's token, storage or files.
 */
export function HtmlView({ api, artifactId, revision }: { api: Api; artifactId: string; revision: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [width, setWidth] = useState<(typeof WIDTHS)[number]["id"]>("wide");
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .previewUrl(artifactId, revision)
      .then((result) => {
        // A late answer for an older revision never replaces the newer one.
        if (!cancelled && result.revision === revision) setUrl(result.url);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
  }, [api, artifactId, revision]);

  const frameWidth = WIDTHS.find((entry) => entry.id === width)!.width;
  return (
    <div className="html-view">
      <div className="doc-tools">
        <div className="segmented small" role="radiogroup" aria-label="화면 폭">
          {WIDTHS.map((entry) => (
            <button key={entry.id} type="button" role="radio" aria-checked={width === entry.id} className={width === entry.id ? "active" : ""} onClick={() => setWidth(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <div className="segmented small" role="radiogroup" aria-label="확대">
          {[0.75, 1, 1.25].map((value) => (
            <button key={value} type="button" role="radio" aria-checked={zoom === value} className={zoom === value ? "active" : ""} onClick={() => setZoom(value)}>
              {Math.round(value * 100)}%
            </button>
          ))}
        </div>
        <span className="muted">r{revision} 실제 렌더링 · 앱 권한 없음</span>
      </div>
      <div className="html-stage">
        {error ? <div className="notice notice-error">{error}</div> : null}
        {url ? (
          <div className="html-frame-wrap" style={{ width: frameWidth ? frameWidth * zoom : `${100}%` }}>
            <iframe
              key={url}
              title="HTML 미리보기"
              src={url}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              referrerPolicy="no-referrer"
              style={{
                width: frameWidth ? frameWidth : `${100 / zoom}%`,
                height: `${100 / zoom}%`,
                transform: `scale(${zoom})`,
              }}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

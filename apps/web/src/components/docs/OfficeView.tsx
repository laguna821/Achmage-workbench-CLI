import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diagramComponents } from "../Diagram.tsx";

const DRAWN = diagramComponents();
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { useOfficePage, useOfficePages, type PageSource } from "../../office.ts";

function PageImage({ source, page, width, label }: { source: PageSource; page: number; width: number; label: string }) {
  const image = useOfficePage(source, page);
  return (
    <figure className="office-page" style={{ maxWidth: Math.min(1000, Math.round(width * 0.66)) }}>
      {image.url ? <img src={image.url} alt={label} loading="lazy" /> : <div className="office-page-wait">{image.error ?? "그리는 중…"}</div>}
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/** Every page of a revision, as IeumOffice lays it out (Word pages, slides, sheets). */
export function OfficePages({ source, kind }: { source: PageSource; kind: "docx" | "pptx" | "xlsx" }) {
  const { pages, error } = useOfficePages(source);
  if (error) return <div className="column empty-hint">{error}</div>;
  if (!pages) return <div className="column empty-hint">쪽 그림을 만드는 중… (처음 한 번 몇 초 걸립니다)</div>;
  const unit = kind === "pptx" ? "번 슬라이드" : "쪽";
  return (
    <div className={`office-pages kind-${kind}`}>
      {pages.map((page) => (
        <PageImage key={page.page} source={source} page={page.page} width={page.width} label={`${page.page}${unit}`} />
      ))}
    </div>
  );
}

/**
 * A Word/PowerPoint/Excel document in the central area: its pages, or its text as IeumOffice
 * reads it. People edit these files in their own office app (the button opens it); AI edits come
 * back as proposals.
 */
export function OfficeView({ api, artifact, revision, mode }: { api: Api; artifact: Artifact; revision: number; mode: "pages" | "text" }) {
  const [text, setText] = useState<{ revision: number; text: string } | { revision: number; error: string } | null>(null);
  useEffect(() => {
    if (mode !== "text") return;
    let active = true;
    api
      .artifactText(artifact.id, revision)
      .then((result) => active && setText({ revision, text: result.text }))
      .catch((error: Error) => active && setText({ revision, error: error.message }));
    return () => {
      active = false;
    };
  }, [api, artifact.id, revision, mode]);
  if (mode === "pages") return <OfficePages source={{ artifactId: artifact.id, revision }} kind={artifact.format as "docx" | "pptx" | "xlsx"} />;
  if (!text || text.revision !== revision) return <div className="column empty-hint">글을 읽는 중…</div>;
  if ("error" in text) return <div className="column empty-hint">{text.error}</div>;
  return (
    <div className="doc-preview office-text">
      <div className="notice">이음오피스가 읽은 글입니다(읽기 전용). 고치려면 AI에게 수정 요청을 보내거나 오피스 앱에서 여세요.</div>
      <div className="markdown">
        <Markdown remarkPlugins={[remarkGfm]} components={DRAWN}>
          {text.text}
        </Markdown>
      </div>
    </div>
  );
}

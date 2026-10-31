import { useEffect, useRef, useState } from "react";
import type { OfficeAiBridge } from "../office-ai.ts";

/** A generated-image file URL is a host capability, never a WebView file grant. */
export function GeneratedImageThumb({ url, title }: { url: string; title?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let active = true, blobUrl: string | undefined;
    setSrc(null);
    const ai = (window as unknown as { workbenchOfficeAi: OfficeAiBridge }).workbenchOfficeAi;
    void ai.desktop.fetchImage(url).then(image => {
      if (!active || !image) return;
      const bytes = Uint8Array.from(atob(image.base64), c => c.charCodeAt(0));
      blobUrl = URL.createObjectURL(new Blob([bytes], { type: image.mime }));
      setSrc(blobUrl);
    }).catch(() => { /* Original thumbnails also hide unavailable/expired images. */ });
    return () => { active = false; if (blobUrl) URL.revokeObjectURL(blobUrl); };
  }, [url]);
  if (!src) return null;
  return <>
    <button className="ai-tool-output-img-btn" onClick={() => dialog.current?.showModal()} data-tip={title ?? "생성 이미지"} aria-label="생성 이미지 크게 보기">
      <img src={src} alt={title ?? "생성 이미지"} loading="lazy" />
    </button>
    <dialog ref={dialog} className="workbench-generated-image" aria-label="생성 이미지 미리보기" onClick={event => { if (event.target === dialog.current) dialog.current?.close(); }}>
      <button autoFocus onClick={() => dialog.current?.close()}>닫기</button>
      <img src={src} alt={title ?? "생성 이미지"} />
    </dialog>
  </>;
}

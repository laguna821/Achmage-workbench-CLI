import { useEffect, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import type { Artifact } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import type { ImageHandling } from "./image-paste.ts";
import "../../styles/doc-images.css";

// Pictures in Markdown documents: what a paste or drop becomes (the gateway uploads to R2 or keeps
// it in the work folder), and the preview of pictures the document links inside its work folder
// (fetched with the app's token, so an <img> cannot load them by address).

/** A src the work folder holds (not an address). */
export const isLocalSrc = (src: string) => Boolean(src) && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//") && !src.startsWith("#");

/** Pictures already fetched for a preview, by document and src: typing in "나란히" redraws the preview often. */
const loaded = new Map<string, Promise<string>>();
const KEPT = 200;

function load(api: Api, artifactId: string, src: string) {
  const key = `${artifactId}\n${src}`;
  let url = loaded.get(key);
  if (!url) {
    url = api.docImage(artifactId, src).then((blob) => URL.createObjectURL(blob));
    url.catch(() => loaded.delete(key));
    loaded.set(key, url);
    if (loaded.size > KEPT) {
      const [oldest, old] = loaded.entries().next().value!;
      loaded.delete(oldest);
      void old.then((value) => URL.revokeObjectURL(value), () => undefined);
    }
  }
  return url;
}

export function DocImage({ api, artifactId, src, alt, title }: { api: Api; artifactId: string; src: string; alt?: string; title?: string }) {
  const local = isLocalSrc(src);
  const [state, setState] = useState<{ src: string; url: string | null; failed: boolean }>({ src, url: null, failed: false });
  useEffect(() => {
    if (!local) return;
    let live = true;
    load(api, artifactId, src).then(
      (url) => live && setState({ src, url, failed: false }),
      () => live && setState({ src, url: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [api, artifactId, src, local]);
  if (!src) return null;
  if (!local) return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
  const current = state.src === src ? state : { url: null, failed: false };
  if (current.failed) return <span className="doc-image-missing" title={src}>그림을 찾지 못했습니다 · {src}</span>;
  return current.url ? <img src={current.url} alt={alt ?? ""} title={title} data-src={src} /> : <span className="doc-image-loading" role="img" aria-label={alt || "그림"} />;
}

const REFUSE_HANGUL = "한글 문서의 글 보기에는 그림을 넣지 못합니다. 그림은 HOP에서 넣어 주세요.";

/** What a pasted or dropped picture becomes in this document, and how the preview shows pictures. */
export function useDocImages(api: Api, artifact: Artifact | undefined, onToast: (message: string) => void) {
  const id = artifact?.id ?? "";
  const format = artifact?.format;
  const handling = useMemo<ImageHandling | null>(() => {
    const clipboard = () => api.clipboardPicture();
    if (format === "hwpx" || format === "hwp") return { refuse: REFUSE_HANGUL, notice: onToast, clipboard };
    if (format !== "markdown") return null;
    return {
      notice: onToast,
      clipboard,
      insert: async (file) => {
        try {
          const result = await api.uploadDocImage(id, file, file.name || "image.png");
          if (result.fallback) onToast(`R2에 올리지 못해 작업 폴더(assets)에 저장했습니다: ${result.fallback}`);
          return result.markdown;
        } catch (error) {
          onToast(`그림을 넣지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      },
    };
  }, [api, id, format, onToast]);
  const components = useMemo<Components>(
    () => ({ img: ({ src, alt, title }) => <DocImage api={api} artifactId={id} src={typeof src === "string" ? src : ""} alt={alt} title={title} /> }),
    [api, id],
  );
  return { handling, components };
}

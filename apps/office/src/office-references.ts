import type { OfficeAttachment, OfficeReferenceRequest } from "../../../packages/contracts/src/office-references.ts";
import type { AgentImage } from "../../../vendor/ieumoffice/packages/agent-core/src/types.ts";
import { listen, post } from "./bridge.ts";

let attachments: () => readonly OfficeAttachment[] = () => [];
let restored: readonly OfficeAttachment[] = [];
let pinned: readonly OfficeAttachment[] | null = null;
const browserFiles = new Map<string, File>();
const browserIds = new WeakMap<File, string>();
/** A browser File has bytes, not filesystem authority. Original synchronous preload APIs use this temporary identity. */
export function officeFileIdentity(file: File): string {
  if (!(file instanceof File)) return "";
  const old = browserIds.get(file);
  if (old && browserFiles.has(old)) return old;
  const id = `workbench-file:${crypto.randomUUID()}`;
  while (browserFiles.size >= 100) browserFiles.delete(browserFiles.keys().next().value!);
  browserFiles.set(id, file); browserIds.set(file, id); return id;
}
const merged = (list: readonly OfficeAttachment[]) => [...new Map([...restored, ...list].map((item) => [item.path, item])).values()];
/** Called by the original files-skill factory through the pinned source adapter. */
export function bindOfficeFiles(get: () => readonly OfficeAttachment[]) {
  attachments = get;
  return () => pinned ?? merged(get());
}
type Request = OfficeReferenceRequest extends infer R ? R extends OfficeReferenceRequest ? Omit<R, "type" | "requestId"> : never : never;
type Added = { accepted: OfficeAttachment[]; rejected: string[] };
type ImageResult = { ok: boolean; base64?: string; mime?: string; error?: string };
const failure = (error: unknown): Added => ({ accepted: [], rejected: [error instanceof Error ? error.message : String(error)] });
export function createOfficeReferences() {
  attachments = () => []; restored = []; pinned = null; browserFiles.clear();
  const imageSources: AgentImage[] = [];
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  listen((message) => {
    if (message.type !== "office:references-result") return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
  });
  const call = <T,>(input: Request): Promise<T> => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("첨부 요청 시간이 초과됐습니다. 다시 선택해 주세요.")); }, input.action === "pick" || input.action === "pick-files" ? 300_000 : 120_000);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timer); resolve(value as T); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    post({ type: "office:references", requestId, ...input });
  });
  const readImage = async (path: string, frozen = false): Promise<ImageResult> => {
    try {
      const result = await call<ImageResult>({ action: "read-image", path, frozen });
      if (result.ok && result.base64 && result.mime) {
        // A preview can refresh after the original composer collected its
        // images. Remember prior bytes too, so none reappear as an extra shot.
        if (!imageSources.some((image) => image.base64 === result.base64 && image.mime === result.mime)) {
          imageSources.push({ base64: result.base64, mime: result.mime });
          if (imageSources.length > 40) imageSources.shift();
        }
      }
      return result;
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  };
  return {
    docs: { available: async () => true, list: () => call({ action: "list" }), pick: () => call({ action: "pick" }) },
    desktop: {
      getPathForFile: officeFileIdentity,
      pickAttachments: () => call<Added | null>({ action: "pick-files" }).catch(failure),
      addPastedImage: async (data: ArrayBuffer | ArrayBufferView, ext: string) => {
        try {
          if (!/^(png|jpe?g|gif|webp)$/i.test(ext) || !data || data.byteLength > 5 * 1024 * 1024) throw new Error("5MB 이하의 이미지만 붙여넣을 수 있습니다.");
          const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
          return await call<Added>({ action: "upload", file: new File([new Uint8Array(bytes)], `붙여넣은 이미지.${ext.toLowerCase()}`) });
        } catch (error) { return failure(error); }
      },
      addAttachmentPaths: async (paths: string[]) => {
        if (!Array.isArray(paths) || paths.length > 20) return failure("한 번에 20개까지 첨부해 주세요.");
        const result: Added = { accepted: [], rejected: [] };
        for (const path of [...new Set(paths)]) {
          try {
            const file = browserFiles.get(path); browserFiles.delete(path);
            if (file && file.size > 50 * 1024 * 1024) throw new Error(`${file.name}: 50MB 이하의 파일만 첨부할 수 있습니다.`);
            const added = await call<Added>(file ? { action: "upload", file } : { action: "add", paths: [path] });
            result.accepted.push(...added.accepted); result.rejected.push(...added.rejected);
          } catch (error) { result.rejected.push(...failure(error).rejected); }
        }
        return result;
      },
      readAttachment: async (path: string, offset = 0, length = 24_000) => {
        try { return await call({ action: "read", path, offset, length }); }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
      },
      readAttachmentImage: (path: string) => readImage(path),
    },
    restore: (list: OfficeAttachment[]) => { restored = list; },
    reset: () => { restored = []; pinned = null; imageSources.length = 0; browserFiles.clear(); },
    pin: () => { pinned = merged(attachments()).map((item) => ({ ...item })); return pinned.map((item) => item.path); },
    /** Original previews are read before run(). Replace those bytes with this turn's frozen files;
     * keep original document screenshots, and include restored pictures in follow-up turns. */
    imagesForTurn: async (images: AgentImage[] = []) => {
      const extra = images.filter((image) => !imageSources.some((source) => source.base64 === image.base64 && source.mime === image.mime));
      const files = (pinned ?? []).filter((item) => /^(png|jpe?g|gif|webp)$/.test(item.ext));
      if (files.length > 20) throw new Error("한 요청에 이미지는 20개까지 첨부해 주세요.");
      const result: AgentImage[] = [];
      for (const file of files) {
        const read = await readImage(file.path, true);
        if (!read.ok || !read.base64 || !read.mime) throw new Error(read.error ?? `${file.name}: 이미지를 읽지 못했습니다.`);
        result.push({ base64: read.base64, mime: read.mime });
      }
      return [...result, ...extra];
    },
    release: () => { pinned = null; },
    async mediaUrls(urls: string[]) {
      const selected = pinned ?? merged(attachments());
      return Promise.all(urls.map(async url => {
        if (!selected.some(item => item.path === url && /^(png|jpe?g|gif|webp)$/.test(item.ext))) return url;
        const image = await readImage(url, pinned !== null);
        if (!image.ok || !image.mime || !image.base64) throw new Error(image.error ?? "첨부 이미지를 읽지 못했습니다.");
        return `data:${image.mime};base64,${image.base64}`;
      }));
    },
  };
}

import { readImageSize } from "@/editor/engine/assets";
import type { AssetRef, EditorAdapter, SaveInput, SaveResult } from "@/types/adapter";
import type { FontFamily, Page } from "@/types/api";
import { fontLister } from "./fonts";
import type { Gateway } from "./gateway";

// The editor's one seam to the outside (doory EditorAdapter), wired to the Workbench gateway: saves
// become revisions of the design file (refused when the file moved on), uploads go next to the file,
// and everything that needs a doory server (templates, stock, brand kits, sharing…) is absent.

const empty = <T>(): Page<T> => ({ count: 0, next: null, previous: null, results: [] });

export type DesignDocumentState = { revision: number };

export function serializeDesign(document: SaveInput["document"]) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function createWorkbenchAdapter(options: {
  gateway: Gateway;
  artifactId: string;
  state: DesignDocumentState;
  fonts: FontFamily[];
  onSaved(revision: number): void;
}): EditorAdapter {
  const { gateway, artifactId, state } = options;
  return {
    async save(input: SaveInput): Promise<SaveResult> {
      const artifact = await gateway.save(artifactId, state.revision, serializeDesign(input.document));
      if (artifact.revision !== state.revision) {
        state.revision = artifact.revision;
        options.onSaved(artifact.revision);
      }
      return { savedAt: Date.now(), revision: artifact.revision };
    },
    // There are no accounts: features that would need one stay closed.
    async requireAccount() {
      return false;
    },
    async uploadAsset(file: File | Blob, opts?: { name?: string }): Promise<AssetRef> {
      const name = opts?.name ?? (file instanceof File ? file.name : "image");
      const { src } = await gateway.upload(artifactId, file, name);
      gateway.remember(artifactId, src, file);
      const audio = file.type.startsWith("audio/");
      const size = audio ? { width: 0, height: 0 } : await readImageSize(await gateway.resolve(artifactId, src));
      return { id: src, url: src, thumbUrl: audio ? "" : src, width: size.width, height: size.height, name, kind: audio ? "audio" : file.type === "image/svg+xml" ? "svg" : "image" };
    },
    resolveSrc: (src: string) => gateway.resolve(artifactId, src),
    services: {
      fonts: fontLister(options.fonts),
      elements: { packs: async () => [], list: async () => empty() },
      templates: {
        categories: async () => [],
        list: async () => empty(),
        get: async () => {
          throw new Error("템플릿은 아직 없습니다.");
        },
      },
      assets: { list: async () => empty(), remove: async () => undefined },
      brand: null,
      stock: null,
      ai: null,
      audioStock: null,
      versions: null,
      sharing: null,
      comments: null,
    },
  };
}

import type { DoryDocument } from "@/types/document";
import { serializeDesign } from "./adapter";
import { post } from "./bridge";
import type { Gateway } from "./gateway";

type File = { blob: Blob; filename: string };
declare global {
  var workbenchDesignDownloads: ((files: readonly File[]) => Promise<void>) | undefined;
  var workbenchDesignSource: ((document: DoryDocument) => number | null) | undefined;
  var workbenchDesignTag: ((files: File[], revision: number | null) => File[]) | undefined;
}

/** The guarded vendor adapter awaits actual host writes; it never patches the browser prototype. */
export function routeDownloads(gateway: Gateway, artifactId: string, source: () => { text: string; revision: number }) {
  const revisions = new WeakMap<Blob, number | null>();
  globalThis.workbenchDesignSource = (document) => {
    const saved = source();
    return serializeDesign(document) === saved.text ? saved.revision : null;
  };
  globalThis.workbenchDesignTag = (files, revision) => {
    for (const file of files) revisions.set(file.blob, revision);
    return files;
  };
  globalThis.workbenchDesignDownloads = async (files) => {
    for (const file of files) {
      const saved = await gateway.exportFile(artifactId, file.blob, file.filename, revisions.get(file.blob) ?? null);
      post({ type: "design:exported", name: saved.name, path: saved.path, artifactId: saved.artifactId });
    }
  };
  return () => {
    delete globalThis.workbenchDesignDownloads;
    delete globalThis.workbenchDesignSource;
    delete globalThis.workbenchDesignTag;
  };
}

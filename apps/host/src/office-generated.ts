import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DocumentAccess } from "@workbench/contracts";
import type { Documents } from "./artifacts.ts";
import { HttpError } from "./errors.ts";

type Generated = { id: string; directory: string; path: string; artifactId: string; viewId: string; sessionId: string | null; revision: number; format: string };
const stores = new WeakMap<Documents, OfficeGenerated>();
/** Private engine outputs. Only the parent-selected output ticket can publish them. */
export const officeGenerated = (documents: Documents) => {
  let store = stores.get(documents);
  if (!store) stores.set(documents, store = new OfficeGenerated(documents));
  return store;
};
class OfficeGenerated {
  private readonly entries = new Map<string, Generated>();
  private readonly documents: Documents;
  constructor(documents: Documents) { this.documents = documents; }
  create(artifactId: string, revision: number, viewId: string, format: "md" | "epub" | "pdf" | "html" | "docx" | "pptx" | "xlsx") {
    const view = this.documents.registry.list().find(v => v.viewId === viewId && v.artifactId === artifactId);
    if (!view) throw new HttpError(409, "output_view_changed", "문서 창을 다시 확인해 주세요.");
    if (this.entries.size >= 100) throw new HttpError(429, "output_busy", "내보내기를 마치거나 문서 탭을 닫아 주세요.");
    const root = join(this.documents.dataDir, "office-generated"); mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = mkdtempSync(join(root, "result-")), id = randomUUID();
    const entry: Generated = { id, directory, path: join(directory, `${id}.${format}`), artifactId, revision, viewId, sessionId: view.sessionId, format };
    this.entries.set(id, entry); return entry;
  }
  read(id: string, artifactId: string, access?: DocumentAccess) {
    const entry = this.entries.get(id);
    const view = this.documents.registry.list().find(v => v.viewId === access?.viewId && v.artifactId === artifactId);
    if (!entry || !view || entry.artifactId !== artifactId || entry.viewId !== view.viewId || entry.sessionId !== view.sessionId) throw new HttpError(403, "output_generated_scope", "이 문서에서 만든 결과만 저장할 수 있습니다.");
    const info = lstatSync(entry.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 200_000_000) throw new HttpError(413, "output_generated_size", "변환 결과를 저장할 수 없는 형식이거나 용량이 너무 큽니다.");
    return { ...entry, bytes: readFileSync(entry.path) };
  }
  discard(id: string) { const entry = this.entries.get(id); if (entry) { rmSync(entry.directory, { recursive: true, force: true }); this.entries.delete(id); } }
  closeView(viewId: string) { for (const entry of this.entries.values()) if (entry.viewId === viewId) this.discard(entry.id); }
}

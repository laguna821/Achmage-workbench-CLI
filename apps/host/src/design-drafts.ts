import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignDraft, DocumentAccess } from "@workbench/contracts";
import type { Documents } from "./artifacts.ts";
import { designProblem } from "./design.ts";
import { HttpError } from "./errors.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** A recovery copy never changes the source and remains available after a host/port restart. */
export class DesignDrafts {
  private readonly root: string;
  private readonly documents: Documents;
  constructor(root: string, documents: Documents) { this.root = root; this.documents = documents; }

  private folder(artifactId: string, access?: DocumentAccess) {
    this.documents.designView(artifactId, access);
    return join(this.root, artifactId);
  }

  list(artifactId: string, access?: DocumentAccess): DesignDraft[] {
    const folder = this.folder(artifactId, access);
    if (!existsSync(folder)) return [];
    return readdirSync(folder).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => {
      const value = JSON.parse(readFileSync(join(folder, name), "utf8")) as DesignDraft;
      if (value.artifactId !== artifactId || hash(value.text) !== value.sha256) throw new HttpError(409, "design_draft_damaged", "보관한 편집 내용을 확인하지 못했습니다. 복구 파일을 보존했습니다.");
      return { ...value, active: value.viewId !== access!.viewId && this.documents.registry.forArtifact(artifactId).some((view) => view.viewId === value.viewId) };
    }).sort((a, b) => b.at - a.at);
  }

  keep(artifactId: string, input: { baseRevision: number; text: string }, access?: DocumentAccess): DesignDraft {
    const folder = this.folder(artifactId, access);
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 1 || input.baseRevision > this.documents.get(artifactId).revision) throw new HttpError(400, "design_draft_revision", "복구본의 기준 판을 확인해 주세요.");
    if (typeof input.text !== "string" || Buffer.byteLength(input.text) > 20_000_000) throw new HttpError(413, "design_draft_size", "디자인 복구본은 20MB까지 보관할 수 있습니다.");
    const problem = designProblem(input.text);
    if (problem) throw new HttpError(422, "invalid_design", problem);
    if (/"src"\s*:\s*"blob:/i.test(input.text)) throw new HttpError(422, "design_draft_asset", "임시 이미지를 파일로 보관한 뒤 복구본을 저장해 주세요.");
    const value: DesignDraft = { artifactId, viewId: access!.viewId, baseRevision: input.baseRevision, text: input.text, sha256: hash(input.text), at: Date.now() };
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${hash(value.viewId)}.json`), temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    return value;
  }

  /** Exact compare-and-delete: a late save may not erase a newer edit or another view's draft. */
  remove(artifactId: string, snapshot: Pick<DesignDraft, "viewId" | "sha256" | "baseRevision" | "at">, access?: DocumentAccess) {
    const folder = this.folder(artifactId, access);
    if (typeof snapshot.viewId !== "string") throw new HttpError(400, "design_draft_identity", "복구본의 창 정보가 필요합니다.");
    const file = join(folder, `${hash(snapshot.viewId)}.json`);
    if (!existsSync(file)) return { removed: false };
    const value = JSON.parse(readFileSync(file, "utf8")) as DesignDraft;
    if (value.sha256 !== snapshot.sha256 || value.baseRevision !== snapshot.baseRevision || value.at !== snapshot.at) return { removed: false };
    // Another live view owns its unsaved edits; recovering a closed view is an explicit UI choice.
    if (snapshot.viewId !== access!.viewId && this.documents.registry.forArtifact(artifactId).some((view) => view.viewId === snapshot.viewId)) throw new HttpError(409, "design_draft_in_use", "다른 창에서 아직 사용하는 복구본입니다.");
    unlinkSync(file);
    return { removed: true };
  }
}

import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CreateTarget, DocFormat } from "@workbench/contracts";
import type { OfficeSkillHandoff } from "../../../packages/contracts/src/office-skills.ts";
import { reservePath } from "./create.ts";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";

type Template = { path: string; sha256: string; skillSha256: string; markdown: string; skillDir: string };
export type CreationTarget = Omit<CreateTarget, "format"> & { format: DocFormat };
export type CreationRecord<T extends CreationTarget = CreationTarget> = {
  version: 1; requestId: string; sessionId: string; workId: string; workspaceId: string | null; fingerprint: string;
  cwd: string; path: string; target: T; sources: { artifactId: string; revision: number }[];
  state: "reserved" | "ready" | "sent" | "completed" | "interrupted" | "failed";
  initialSha256: string; skillPath: string | null; skillDir: string | null;
  artifactId: string | null; problem: string | null; createdAt: number; updatedAt: number;
  office?: { sourceArtifactId: string; sourceViewId: string; handoff: OfficeSkillHandoff; state: "queued" | "taken" | "interrupted"; claimedViewId?: string };
};
const PREFIX = "document-creation:";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const key = (id: string) => PREFIX + hash(id);

/** File reservations survive a gateway restart. A repeated request never chooses another name. */
export class CreationJournal {
  private readonly store: Pick<Store, "getMeta" | "setMeta" | "metaEntries">;
  private readonly dataDir: string;
  constructor(store: Pick<Store, "getMeta" | "setMeta" | "metaEntries">, dataDir: string) { this.store = store; this.dataDir = dataDir; }
  get<T extends CreationTarget = CreationTarget>(id: string): CreationRecord<T> | null {
    const raw = this.store.getMeta(key(id));
    if (!raw) return null;
    let value: CreationRecord<T>;
    try { value = JSON.parse(raw); } catch { throw new HttpError(409, "creation_record_unreadable", "생성 기록을 읽을 수 없어 원본 상태를 보존했습니다."); }
    if (value.version !== 1 || value.requestId !== id) throw new HttpError(409, "creation_record_version", "다른 버전의 생성 기록을 보존했습니다.");
    return value;
  }
  list(): CreationRecord[] {
    return this.store.metaEntries(PREFIX).flatMap(({ value }) => {
      try { const item = JSON.parse(value); return item.version === 1 && typeof item.requestId === "string" ? [item as CreationRecord] : []; }
      catch { return []; }
    });
  }
  update<T extends CreationTarget = CreationTarget>(id: string, patch: Partial<Pick<CreationRecord, "state" | "artifactId" | "problem" | "office">>) {
    const current = this.get<T>(id);
    if (!current) return;
    const record = { ...current, ...patch, updatedAt: Date.now() };
    this.store.setMeta(key(id), JSON.stringify(record));
    return record;
  }
  reserve<T extends CreationTarget>(input: Pick<CreationRecord<T>, "requestId" | "sessionId" | "workId" | "workspaceId" | "fingerprint" | "cwd" | "target" | "sources">, template: Template | null): CreationRecord<T> {
    const previous = this.get<T>(input.requestId);
    if (previous) {
      if (previous.sessionId !== input.sessionId || previous.fingerprint !== input.fingerprint || previous.cwd !== resolve(input.cwd)) throw new HttpError(409, "request_id_conflict", "같은 requestId로 다른 문서를 만들 수 없습니다.");
      if (previous.state === "ready") {
        if (!existsSync(previous.path) || hash(readFileSync(previous.path)) !== previous.initialSha256) throw new HttpError(409, "creation_copy_changed", "준비한 사본이 바뀌었거나 이동했습니다. 기존 파일을 확인해 주세요.");
        return previous;
      }
      throw new HttpError(409, "creation_already_recorded", `이미 기록한 생성 요청입니다 (${previous.state}). 기존 사본을 확인해 주세요.`);
    }
    const cwd = resolve(input.cwd);
    mkdirSync(cwd, { recursive: true });
    const reserved = new Set(this.list().filter((item) => ["reserved", "ready", "sent"].includes(item.state)).map((item) => item.path));
    const path = reservePath(cwd, input.target, reserved);
    const skillPath = template ? join(this.dataDir, "template-instructions", `${template.skillSha256}.md`) : null;
    if (template) {
      if (hash(readFileSync(template.path)) !== template.sha256 || hash(template.markdown) !== template.skillSha256) throw new HttpError(409, "template_changed", "선택한 양식 판을 확인할 수 없습니다.");
      mkdirSync(join(this.dataDir, "template-instructions"), { recursive: true });
      try { writeFileSync(skillPath!, template.markdown, { flag: "wx", mode: 0o444 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (hash(readFileSync(skillPath!)) !== template.skillSha256) throw new HttpError(409, "template_changed", "양식 설명 사본의 내용이 바뀌었습니다.");
    }
    const record: CreationRecord<T> = { ...input, version: 1, cwd, path, initialSha256: template?.sha256 ?? hash(""), skillPath, skillDir: template?.skillDir ?? null, state: "reserved", artifactId: null, problem: null, createdAt: Date.now(), updatedAt: Date.now() };
    this.store.setMeta(key(input.requestId), JSON.stringify(record));
    try {
      if (template) copyFileSync(template.path, path, constants.COPYFILE_EXCL);
      else writeFileSync(path, "", { flag: "wx" });
      // Copying a read-only snapshot preserves its mode on some platforms. The new file is editable.
      if (template) { const { mode } = statSync(path); if (!(mode & 0o200)) chmodSync(path, 0o600); }
      if (hash(readFileSync(path)) !== record.initialSha256) throw new Error("사본 검증에 실패했습니다.");
      return this.update<T>(record.requestId, { state: "ready" })!;
    } catch (error) {
      this.update(record.requestId, { state: "failed", problem: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

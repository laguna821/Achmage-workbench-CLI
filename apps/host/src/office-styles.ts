import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeTemplateSelection, type TemplateSelection } from "../../../vendor/ieumoffice/apps/slides/src/shared/template-selection.ts";
import type { Documents } from "./artifacts.ts";
import type { EditorGrants } from "./editors.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";
import { openerFor } from "./open-url.ts";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (message: string, status = 400) => new HttpError(status, "office_style", message);
const text = (v: unknown, size: number): v is string => typeof v === "string" && v.length <= size;
type Context = { artifactId: string; token: string; grants: EditorGrants };
type Selection = { revision: string | null; selection: TemplateSelection | null };
type Style = { name: string; revision: string; data: Record<string, unknown> & { topic: string; styleSkill: string; createdAt: string } };

function read<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw fail("스타일 보관 파일을 확인해 주세요. 원본을 보존했습니다.", 409);
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { throw fail("스타일 보관 파일을 읽지 못했습니다. 원본을 보존했습니다.", 409); }
}
function write(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 }); renameSync(temp, file);
}
/** Save As keeps the current design choice while retaining the destination's previous choice. */
export function copyOfficeStyleSelection(dataDir: string, sourceId: string, targetId: string) {
  const root = join(dataDir, "office-styles", "selections");
  const source = read<Selection>(join(root, `${hash(sourceId)}.json`));
  if (!source) return;
  const target = join(root, `${hash(targetId)}.json`), previous = read<Selection>(target);
  if (previous) write(join(root, "history", `${hash(targetId)}-${randomUUID()}.json`), previous);
  write(target, { ...source, revision: randomUUID() });
}
function styleData(value: unknown): Style["data"] {
  if (!object(value) || !text(value.topic, 100_000) || !text(value.styleSkill, 1_000_000) || !value.styleSkill.trim() || !text(value.createdAt, 100)
    || (value.layout !== undefined && !object(value.layout)) || (value.basedOn !== undefined && !text(value.basedOn, 128))) throw fail("저장할 디자인 스타일 형식을 확인해 주세요.");
  // Preserve the original layout skeleton and future JSON fields, within the request size cap.
  return value as Style["data"];
}
function nameOf(value: unknown): string {
  if (!text(value, 128) || !value.trim() || value !== value.trim() || /[\x00-\x1f\\/]/.test(value)) throw fail("스타일 이름을 확인해 주세요.");
  return value;
}

/** Only design data: no skill activation, model request or arbitrary filesystem path. */
export class OfficeStyles {
  private readonly documents: Documents;
  private readonly root: string;
  private readonly fonts: string | null;
  constructor(documents: Documents, webDir: string | null) {
    this.documents = documents; this.root = join(documents.dataDir, "office-styles");
    this.fonts = webDir ? join(webDir, "office", "template-fonts") : null;
  }
  private scope(context: Context, writable = false) {
    const { artifactId, token, grants } = context;
    if (!grants.allows(token, artifactId)) throw fail("이 문서의 디자인 권한이 없습니다.", 401);
    const artifact = this.documents.get(artifactId), access = grants.access(token);
    const view = this.documents.registry.list().find((entry) => entry.viewId === access?.viewId);
    if (artifact.format !== "pptx" || !view || view.artifactId !== artifactId || view.sessionId !== grants.session(token)) throw fail("문서 창이나 연결된 대화가 바뀌었습니다.", 409);
    if (writable) this.documents.registry.assertWrite(artifactId, access);
    return artifact;
  }
  call(context: Context, operation: string, input: unknown = {}): unknown {
    const artifact = this.scope(context, ["selection-set", "save", "sidecar"].includes(operation));
    if (!object(input)) throw fail("디자인 요청 형식이 올바르지 않습니다.");
    const selectionFile = join(this.root, "selections", `${hash(artifact.id)}.json`);
    if (operation === "selection-get" || operation === "selection-set") {
      const previous = read<Selection>(selectionFile) ?? { revision: null, selection: null };
      if (operation === "selection-get") return previous;
      if (previous.revision !== input.expectedRevision) throw fail("다른 창에서 디자인 선택이 바뀌었습니다. 다시 선택해 주세요.", 409);
      const selection = input.selection === null ? null : normalizeTemplateSelection(input.selection, Date.now());
      if (input.selection !== null && !selection) throw fail("디자인 선택 정보가 올바르지 않습니다.");
      if (selection?.kind === "saved" && !this.style(selection.key)) throw fail("선택한 저장 스타일을 찾을 수 없습니다.", 404);
      const next = { revision: randomUUID(), selection }; write(selectionFile, next); return next;
    }
    if (operation === "list") {
      const folder = join(this.root, "styles");
      if (!existsSync(folder)) return [];
      return readdirSync(folder).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).map((name) => read<Style>(join(folder, name)))
        .filter((style): style is Style => !!style).map(({ name, data }) => ({ name, topic: data.topic, createdAt: data.createdAt }));
    }
    if (operation === "load" || operation === "save") {
      const name = nameOf(input.name), previous = this.style(name);
      if (operation === "load") return previous ? { ok: true, ...previous.data, revision: previous.revision } : { ok: false, error: "저장한 스타일이 없습니다.", revision: null };
      const data = styleData(input.data);
      if ((previous?.revision ?? null) !== input.expectedRevision) throw fail("저장 스타일이 다른 창에서 바뀌었습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.", 409);
      const serialized = JSON.stringify({ name, data }), revision = hash(serialized);
      const next: Style = { name, data, revision };
      // Every style version survives even when the original save tool reuses a name.
      if (previous) write(join(this.root, "history", hash(name), `${previous.revision}.json`), previous);
      write(join(this.root, "history", hash(name), `${revision}.json`), next);
      write(join(this.root, "styles", `${hash(name)}.json`), next);
      return { ok: true, revision };
    }
    if (operation === "sidecar") {
      const data = styleData(input.data), file = artifact.path.replace(/\.pptx$/i, ".styleskill.json");
      if (file === artifact.path) throw fail("PPTX 문서의 스타일 파일 경로가 없습니다.");
      if (existsSync(file)) {
        if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw fail("기존 스타일 파일이 링크입니다. 원본을 보존했습니다.", 409);
        const prior = readFileSync(file), backup = join(this.root, "sidecars", hash(artifact.id), `${hash(prior)}.json`);
        mkdirSync(dirname(backup), { recursive: true });
        if (!existsSync(backup)) writeFileSync(backup, prior, { flag: "wx", mode: 0o600 });
      }
      write(file, data); return { ok: true };
    }
    throw fail("지원하지 않는 디자인 요청입니다.");
  }
  private style(name: string) { return read<Style>(join(this.root, "styles", `${hash(name)}.json`)); }
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, token: string | null, grants: EditorGrants) {
    const match = /^\/api\/artifacts\/([^/]+)\/ai\/styles\/(selection-get|selection-set|list|load|save|sidecar|fonts-folder)$/.exec(url.pathname);
    if (!match) return false;
    if (req.method !== "POST") throw fail("허용되지 않은 디자인 요청입니다.", 405);
    let input: unknown;
    try { input = JSON.parse((await readBody(req, 2_000_000)).toString("utf8")); } catch (error) { if (error instanceof HttpError) throw error; throw fail("디자인 요청을 읽지 못했습니다."); }
    const context = { artifactId: match[1]!, token: token ?? "", grants };
    res.setHeader("cache-control", "no-store");
    if (match[2] === "fonts-folder") {
      this.scope(context);
      if (!this.fonts || !existsSync(join(this.fonts, "README.md"))) throw fail("템플릿 글꼴 폴더가 설치되지 않았습니다.", 404);
      const command = openerFor(pathToFileURL(this.fonts).href);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command.command, command.args, { stdio: "ignore", windowsHide: true });
        child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(fail("글꼴 폴더를 열지 못했습니다.", 500)));
      });
      sendJson(res, 200, true); return true;
    }
    sendJson(res, 200, this.call(context, match[2]!, input)); return true;
  }
}

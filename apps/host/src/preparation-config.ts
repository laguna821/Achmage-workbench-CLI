import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { HookSource, WorkspaceEnvironment } from "@workbench/contracts";
import { HttpError } from "./errors.ts";

export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const FILE_LIMIT = 262_144, STRING_LIMIT = 65_536;
export const defaultEnvironment = (): WorkspaceEnvironment => ({ revision: 0, setupScript: "", archiveScript: "", setupSource: "auto", archiveSource: "auto", sharedPaths: [], waitForSetup: false, bashPath: "" });
const mapping = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const configString = (value: unknown) => typeof value === "string" && value.length <= STRING_LIMIT && Buffer.byteLength(value) <= STRING_LIMIT && !value.includes("\0") ? value.trim() : "";
export function relativeEntry(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value)) return null;
  const path = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!path || path.startsWith("!") || /^[A-Za-z]:/.test(path) || /[*?]/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) return null;
  return path;
}
function paths(value: unknown, limit: number, warnings: string[]): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > limit) warnings.push(`경로 목록은 처음 ${limit}개까지만 읽습니다.`);
  return [...new Set(value.slice(0, limit).flatMap((value) => { const entry = relativeEntry(value); if (!entry) warnings.push("지원하지 않는 상대 경로를 건너뛰었습니다."); return entry ? [entry] : []; }))];
}
export function readConfiguration(path: string, warnings: string[]): { text: string; hash: string } {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) throw new Error("일반 파일이 아닙니다");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > FILE_LIMIT) throw new Error("256 KiB를 넘었습니다");
    const text = readFileSync(fd, "utf8"), after = fstatSync(fd);
    if (text.length > FILE_LIMIT || Buffer.byteLength(text) > FILE_LIMIT || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("읽는 동안 변경되거나 크기를 넘었습니다");
    return { text, hash: digest(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { text: "", hash: "absent-or-invalid" };
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function readOrca(root: string) {
  const warnings: string[] = [];
  const input = readConfiguration(join(root, "orca.yaml"), warnings);
  const empty = { setup: "", archive: "", shared: [] as string[], tabs: [] as { title: string; command: string | null; color?: string }[], wait: false };
  try {
    const document = parseDocument(input.text, { uniqueKeys: true });
    if (document.errors.length) throw new Error(document.errors[0]!.message);
    const parsed: unknown = document.toJS({ maxAliasCount: 100 });
    if (input.text.trim() && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("최상위 값은 매핑이어야 합니다");
    const config = mapping(parsed), scripts = mapping(config.scripts), worktree = mapping(config.worktree);
    const tabs: typeof empty.tabs = [];
    if (Array.isArray(config.defaultTabs)) {
      if (config.defaultTabs.length > 256) warnings.push("defaultTabs가 256개를 넘어 전체 목록을 건너뛰었습니다.");
      else for (const raw of config.defaultTabs) {
        const tab = mapping(raw), title = configString(tab.title), command = configString(tab.command);
        const color = typeof tab.color === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(tab.color) ? tab.color : undefined;
        if (title || command || color) tabs.push({ title: title.slice(0, 80) || "터미널", command: command || null, ...(color ? { color } : {}) });
      }
    }
    return { ...empty, setup: configString(scripts.setup), archive: configString(scripts.archive), shared: paths(worktree.sharedDirectories, 100, warnings), tabs, wait: config.setupAgentStartupPolicy === "wait-for-setup", hash: input.hash, warnings };
  } catch (error) {
    warnings.push(`${join(root, "orca.yaml")}: 설정 전체를 읽지 않았습니다. ${error instanceof Error ? error.message : String(error)}`);
    return { ...empty, hash: input.hash, warnings };
  }
}
export function readIncludes(root: string) {
  const warnings: string[] = [], input = readConfiguration(join(root, ".worktreeinclude"), warnings);
  const lines = input.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const selected = new Set<string>(); let invalid = 0;
  for (const line of lines) {
    const entry = relativeEntry(line); if (!entry) { invalid++; continue; }
    if (selected.has(entry)) continue;
    if (selected.size >= 1000) { warnings.push(".worktreeinclude는 유효한 경로 1,000개까지만 읽습니다."); break; }
    selected.add(entry);
  }
  if (invalid) warnings.push(`.worktreeinclude의 지원하지 않는 경로 ${invalid}개를 건너뛰었습니다.`);
  return { paths: [...selected], hash: input.hash, warnings };
}
export function selectHook(shared: string, local: string, requested: HookSource) {
  const source = requested === "auto" ? local ? "local-only" : "shared-only" : requested;
  return { source, script: source === "local-only" ? local : source === "shared-only" ? shared : [shared, local].filter(Boolean).join("\n") };
}
export function validateEnvironment(value: unknown): Omit<WorkspaceEnvironment, "revision"> {
  const data = mapping(value), policies: HookSource[] = ["auto", "shared-only", "local-only", "run-both"];
  for (const key of ["setupSource", "archiveSource"] as const) if (!policies.includes(data[key] as HookSource)) throw new HttpError(400, "environment_policy", "명령 출처를 선택해 주세요.");
  for (const key of ["setupScript", "archiveScript", "bashPath"] as const) if (typeof data[key] !== "string" || (data[key] as string).length > STRING_LIMIT || Buffer.byteLength(data[key] as string) > STRING_LIMIT || (data[key] as string).includes("\0")) throw new HttpError(400, "environment_script", "스크립트 크기와 내용을 확인해 주세요.");
  if (!Array.isArray(data.sharedPaths) || data.sharedPaths.length > 100 || data.sharedPaths.some((entry) => !relativeEntry(entry))) throw new HttpError(400, "environment_paths", "공유 경로는 최대 100개의 저장소 상대 경로여야 합니다.");
  if (typeof data.waitForSetup !== "boolean") throw new HttpError(400, "environment_wait", "준비 대기 설정을 확인해 주세요.");
  return { setupScript: configString(data.setupScript), archiveScript: configString(data.archiveScript), setupSource: data.setupSource as HookSource, archiveSource: data.archiveSource as HookSource, sharedPaths: [...new Set(data.sharedPaths.map((entry) => relativeEntry(entry)!))], waitForSetup: data.waitForSetup, bashPath: configString(data.bashPath) };
}

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { readPluginManifest } from "@workbench/paseo-plugin-host/manifest";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "@workbench/paseo-server-transport/private-files";
import type { ExtensionArtifact, ExtensionManifest, ExtensionRecord, ExtensionRun } from "@workbench/contracts";
import { HttpError } from "../errors.ts";
import { normalizePermissions } from "./permissions.ts";

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const ID = /^[a-z][a-z0-9._-]{0,79}$/;
const SAFE_IMPORTS = new Set(["@getpaseo/plugin", "@getpaseo/plugin/server", "@getpaseo/plugin/server/provider", "zod"]);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const bad = (message: string) => new HttpError(400, "extension_package", message);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseExtensionManifest(raw: unknown): ExtensionManifest {
  if (!object(raw) || raw.apiVersion !== 1 || raw.runtime !== "paseo-quickjs-v1") throw bad("지원하는 확장 API 또는 실행 형식이 아닙니다.");
  for (const key of ["id", "name", "version", "license"] as const) {
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 200) throw bad(`잘못된 manifest ${key}`);
  }
  if (!ID.test(raw.id as string) || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(raw.version as string)) throw bad("확장 ID 또는 버전이 잘못되었습니다.");
  if (!object(raw.source) || typeof raw.source.url !== "string" || typeof raw.source.revision !== "string"
    || !raw.source.url || !raw.source.revision || raw.source.revision.length > 200) throw bad("원본 URL과 revision을 기록해야 합니다.");
  if (!Array.isArray(raw.capabilities) || !raw.capabilities.length || raw.capabilities.some(v => !["tool", "screen", "provider"].includes(v))) throw bad("지원 capability가 필요합니다.");
  const names = new Set<string>();
  for (const kind of ["tools", "screens", "providers"] as const) {
    if (!Array.isArray(raw[kind]) || raw[kind].length > 30) throw bad(`잘못된 ${kind}`);
    for (const item of raw[kind]) {
      if (!object(item) || typeof item.id !== "string" || !ID.test(item.id) || typeof item.title !== "string" || !item.title.trim()) throw bad("기여 항목 ID와 제목이 필요합니다.");
      if (names.has(`${kind}:${item.id}`)) throw bad("기여 항목 ID가 중복되었습니다.");
      names.add(`${kind}:${item.id}`);
      if (kind === "screens") {
        if (typeof item.file !== "string" || !/^screens\/[a-zA-Z0-9_./-]+\.html$/.test(item.file) || item.file.split("/").includes("..")) throw bad("화면은 패키지 screens/*.html 파일이어야 합니다.");
      } else if (typeof item.method !== "string" || !ID.test(item.method)) throw bad("RPC 또는 provider ID가 필요합니다.");
    }
    const cap = kind === "tools" ? "tool" : kind === "screens" ? "screen" : "provider";
    if (raw[kind].length && !raw.capabilities.includes(cap)) throw bad("기여 항목의 capability가 선언되지 않았습니다.");
  }
  const manifest = structuredClone(raw) as ExtensionManifest;
  manifest.permissions = normalizePermissions(manifest.permissions);
  return manifest;
}

/** Validate syntax without evaluating any author file or following package managers. */
function checkImports(filename: string, source: string, filenames: Set<string>): void {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (file.referencedFiles.length || file.typeReferenceDirectives.length) throw bad("외부 reference directive는 지원하지 않습니다.");
  function specifier(value: ts.Node | undefined): void {
    if (!value || !ts.isStringLiteralLike(value)) throw bad("동적인 모듈 불러오기는 지원하지 않습니다.");
    const name = value.text;
    if (SAFE_IMPORTS.has(name)) return;
    if (!name.startsWith(".") || /[\\:]/.test(name)) throw bad(`허용하지 않은 import ${name}`);
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), name));
    if (resolved.startsWith("../") || path.posix.isAbsolute(resolved)) throw bad("패키지 밖 import는 거절됩니다.");
    const candidates = [resolved, resolved.replace(/\.js$/, ".ts"), `${resolved}.ts`, `${resolved}/index.ts`];
    if (!candidates.some(candidate => filenames.has(candidate) && /\.ts$/.test(candidate))) throw bad(`패키지 안에서 해결할 수 없는 import ${name}`);
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) specifier(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node)) throw bad("import equals는 지원하지 않습니다.");
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === "require")) specifier(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(file);
}

export class ExtensionRegistry {
  readonly directory: string;
  private readonly file: string;
  private records: ExtensionRecord[] = [];
  private runs: ExtensionRun[] = [];
  constructor(dataDir: string) {
    this.directory = path.join(dataDir, "extensions"); this.file = path.join(this.directory, "registry.json");
    if (existsSync(this.directory) && lstatSync(this.directory).isSymbolicLink()) throw bad("확장 저장소는 링크일 수 없습니다.");
    ensurePrivateDirectory(this.directory);
    if (existsSync(this.file)) {
      if (lstatSync(this.file).isSymbolicLink()) throw bad("확장 기록은 링크일 수 없습니다.");
      const data = JSON.parse(readFileSync(this.file, "utf8"));
      if (!object(data) || data.version !== 1 || !Array.isArray(data.extensions) || !Array.isArray(data.runs)) throw bad("확장 기록을 읽을 수 없습니다. 원본은 유지했습니다.");
      for (const record of data.extensions) {
        if (!object(record) || !object(record.grant) || typeof record.artifactHash !== "string" || !/^[a-f0-9]{64}$/.test(record.artifactHash)) throw bad("손상한 확장 기록입니다.");
        parseExtensionManifest(record.manifest);
      }
      this.records = data.extensions as ExtensionRecord[];
      this.runs = (data.runs as ExtensionRun[]).map(run => run.status === "running" ? { ...run, status: "cancelled", finishedAt: Date.now(), error: "Host stopped before this run settled" } : run);
    }
  }
  list(): ExtensionRecord[] { return structuredClone(this.records); }
  history(): ExtensionRun[] { return structuredClone(this.runs); }
  get(id: string): ExtensionRecord {
    const item = this.records.find(record => record.manifest.id === id);
    if (!item) throw new HttpError(404, "extension_missing", "설치된 확장이 없습니다.");
    return structuredClone(item);
  }
  put(record: ExtensionRecord): void {
    const next = this.records.filter(item => item.manifest.id !== record.manifest.id); next.push(structuredClone(record));
    this.commit(next, this.runs);
  }
  recordRun(run: ExtensionRun): void {
    const next = [structuredClone(run), ...this.runs.filter(item => item.id !== run.id)].slice(0, 100);
    this.commit(this.records, next);
  }
  artifactDirectory(artifact: ExtensionArtifact): string { return path.join(this.directory, "artifacts", artifact.artifactHash); }
  verify(artifact: ExtensionArtifact): string {
    const directory = this.artifactDirectory(artifact);
    if (lstatSync(directory).isSymbolicLink() || readFileSync(path.join(directory, "tsconfig.json"), "utf8") !== '{"compilerOptions":{"types":[]}}\n') throw bad("확장 컴파일 설정이 변경되었습니다.");
    for (const file of artifact.files) {
      const location = path.join(directory, file.path);
      const info = lstatSync(location);
      if (!info.isFile() || info.isSymbolicLink() || hash(readFileSync(location)) !== file.sha256) throw bad("설치된 확장 파일의 hash가 변경되었습니다.");
    }
    return directory;
  }
  async stage(directory: string, expectedHash?: string): Promise<ExtensionArtifact> {
    const root = realpathSync(directory);
    if (lstatSync(directory).isSymbolicLink()) throw bad("설치 디렉터리는 링크일 수 없습니다.");
    const entries: { path: string; data: Buffer }[] = [];
    let total = 0, nodes = 0;
    const walk = (folder: string, prefix: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const relative = prefix + entry.name, location = path.join(folder, entry.name);
        if (++nodes > 128 || relative.split("/").length > 12) throw bad("확장 패키지의 폴더 수 또는 깊이 제한을 초과했습니다.");
        if (entry.isSymbolicLink()) throw bad("확장 패키지에 링크를 넣을 수 없습니다.");
        if (entry.isDirectory()) {
          if (!/^(server|shared|screens)(\/|$)/.test(relative)) throw bad(`지원하지 않는 패키지 폴더 ${relative}`);
          walk(location, relative + "/"); continue;
        }
        if (!entry.isFile() || !/^(paseo-plugin\.json|workbench-extension\.json|LICENSE(?:\.[a-zA-Z]+)?|NOTICE(?:\.[a-zA-Z]+)?|README\.md|index\.server\.ts|(?:server|shared)\/[a-zA-Z0-9_./-]+\.ts|screens\/[a-zA-Z0-9_./-]+\.html)$/.test(relative)) throw bad(`지원하지 않는 패키지 파일 ${relative}`);
        const info = lstatSync(location); total += info.size;
        if (entries.length >= 64 || total > MAX_PACKAGE_BYTES) throw bad("확장 패키지는 64개 파일과 2 MiB 이하여야 합니다.");
        entries.push({ path: relative, data: readFileSync(location) });
      }
    };
    walk(root, ""); entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const names = new Set(entries.map(entry => entry.path));
    if (!names.has("LICENSE") || !names.has("index.server.ts")) throw bad("LICENSE와 index.server.ts가 필요합니다.");
    for (const entry of entries) if (entry.path.endsWith(".ts")) checkImports(entry.path, entry.data.toString("utf8"), names);
    const manifestEntry = entries.find(entry => entry.path === "workbench-extension.json");
    if (!manifestEntry) throw bad("workbench-extension.json이 필요합니다.");
    const manifest = parseExtensionManifest(JSON.parse(manifestEntry.data.toString("utf8")));
    const paseoEntry = entries.find(entry => entry.path === "paseo-plugin.json");
    if (!paseoEntry || JSON.parse(paseoEntry.data.toString("utf8")).build !== undefined) throw bad("paseo-plugin.json이 필요하며 author build 명령은 허용하지 않습니다.");
    for (const screen of manifest.screens) if (!names.has(screen.file)) throw bad("화면 파일이 없습니다.");
    const files = entries.map(entry => ({ path: entry.path, sha256: hash(entry.data), bytes: entry.data.byteLength }));
    const artifactHash = hash(JSON.stringify(files));
    if (expectedHash && expectedHash !== artifactHash) throw new HttpError(409, "extension_hash_mismatch", "검토한 패키지 hash와 다릅니다.");
    const artifact: ExtensionArtifact = { manifest, artifactHash, installedAt: Date.now(), files };
    const destination = this.artifactDirectory(artifact);
    if (!existsSync(destination)) {
      ensurePrivateDirectory(destination);
      for (const entry of entries) {
        const target = path.join(destination, entry.path); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, entry.data, { mode: 0o600, flag: "wx" });
      }
      // A controlled config stops the original compiler from discovering an ambient user config.
      writeFileSync(path.join(destination, "tsconfig.json"), '{"compilerOptions":{"types":[]}}\n', { mode: 0o600, flag: "wx" });
    }
    this.verify(artifact);
    const paseo = await readPluginManifest(destination);
    if (paseo.id !== manifest.id) throw bad("Paseo manifest와 Workbench manifest ID가 다릅니다.");
    return artifact;
  }
  private commit(records: ExtensionRecord[], runs: ExtensionRun[]): void {
    if (existsSync(this.file) && lstatSync(this.file).isSymbolicLink()) throw bad("확장 기록은 링크일 수 없습니다.");
    writePrivateFileAtomicSync(this.file, JSON.stringify({ version: 1, extensions: records, runs }) + "\n");
    this.records = structuredClone(records); this.runs = structuredClone(runs);
  }
}

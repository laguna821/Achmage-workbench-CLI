import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import manifest from "../../../scripts/agent-desktop-manifest.json" with { type: "json" };
import { HttpError } from "./errors.ts";

type Platform = { target: string; binaryName: string; entries: string[] };
type Installer = { installArchive(archive: string, binary: string, helper: string | undefined, entry: Platform, stagingRoot: string): void; matchesRecordedDigest(path: string): boolean };
const require = createRequire(import.meta.url);
const original = () => require("@workbench/agent-desktop-installer") as Installer;
const platformEntry = () => (require("@workbench/agent-desktop-installer/lib/platform.js") as { resolve(platform: string, arch: string): Platform | undefined }).resolve(process.platform, process.arch);

/** Imports the upstream installer functions only. Its automatic install/cleanup/main is never run. */
export class DesktopInstall {
  readonly root: string;
  readonly stateRoot: string;
  readonly version = manifest.version;
  installing = false;
  error: string | null = null;
  private controller: AbortController | null = null;
  constructor(dataDir: string) {
    this.root = join(dataDir, "desktop", manifest.version, `${process.platform}-${process.arch}`);
    this.stateRoot = join(dataDir, "desktop", "state");
    mkdirSync(this.stateRoot, { recursive: true, mode: 0o700 });
  }
  get supported() { return !!platformEntry(); }
  get binary() { const entry = platformEntry(); return entry ? join(this.root, entry.entries[0]!) : null; }
  get installed() {
    try {
      const entry = platformEntry();
      if (!entry || !existsSync(join(this.root, "release.json"))) return false;
      const receipt = JSON.parse(readFileSync(join(this.root, "release.json"), "utf8"));
      return receipt.revision === manifest.revision && entry.entries.every(name => original().matchesRecordedDigest(join(this.root, name)));
    } catch { return false; }
  }
  async install() {
    if (this.installing) throw new HttpError(409, "desktop_install_busy", "외부 앱 도구를 설치 중입니다.");
    if (this.installed) return;
    const entry = platformEntry();
    if (!entry) throw new HttpError(422, "desktop_platform", "이 운영체제·CPU용 공식 실행 파일이 없습니다.");
    const name = `agent-desktop-v${manifest.version}-${entry.target}.tar.gz`;
    const asset = (manifest.assets as Record<string, { url: string; sha256: string; bytes: number }>)[name];
    if (!asset) throw new Error("공식 실행 파일 정보가 없습니다.");
    this.installing = true; this.error = null; this.controller = new AbortController();
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const archive = join(this.root, `.download-${randomUUID()}.tar.gz`);
    try {
      const response = await fetch(asset.url, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(120_000)]) });
      if (!response.ok || !response.body) throw new Error(`다운로드 실패: HTTP ${response.status}`);
      const chunks: Buffer[] = []; let bytes = 0;
      const reader = response.body.getReader();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > asset.bytes) throw new Error("공식 파일 크기와 다릅니다."); chunks.push(Buffer.from(value)); }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const data = Buffer.concat(chunks);
      if (bytes !== asset.bytes || createHash("sha256").update(data).digest("hex") !== asset.sha256) throw new Error("공식 실행 파일의 SHA-256 또는 크기가 일치하지 않습니다.");
      writeFileSync(archive, data, { mode: 0o600 });
      original().installArchive(archive, this.binary!, entry.entries[1] ? join(this.root, entry.entries[1]) : undefined, entry, this.root);
      writeFileSync(join(this.root, "release.json"), JSON.stringify({ revision: manifest.revision, sha256: asset.sha256 }), { mode: 0o600 });
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); throw error; }
    finally { rmSync(archive, { force: true }); this.installing = false; this.controller = null; }
  }
  close() { this.controller?.abort(); }
}

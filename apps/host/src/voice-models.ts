import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import pino from "pino";
import { downloadToFile, ensureSherpaOnnxModel, extractTarArchive } from "@workbench/paseo-voice-server/model-downloader";
import type { VoiceModel } from "@workbench/contracts";
import manifest from "../../../packaging/voice-models.json" with { type: "json" };

const logger = pino({ level: "silent" });
const localModel = manifest.models.find(model => model.id === "whisper-base")!;
const platform = `${process.platform}-${process.arch}`;
type FileReceipt = { path: string; bytes: number; mtimeMs: number; sha256: string };
type TreeReceipt = { revision: string; files: FileReceipt[]; installedBytes: number; archiveSha256?: string };
type Download = { controller: AbortController; receivedBytes: number; error: string | null; active: boolean };
const receiptName = ".workbench-voice-install.json";

export class VoiceModelError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function inventory(directory: string, prefix = ""): Promise<FileReceipt[]> {
  const rows: FileReceipt[] = [];
  for (const item of await readdir(join(directory, prefix), { withFileTypes: true })) {
    if (item.name === receiptName) continue;
    const path = join(prefix, item.name), full = join(directory, path);
    if (item.isSymbolicLink()) throw new Error("음성 설치 파일에 허용되지 않은 심볼릭 링크가 있습니다.");
    if (item.isDirectory()) rows.push(...await inventory(directory, path));
    else if (item.isFile()) { const stat = await lstat(full); rows.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: await sha256(full) }); }
    else throw new Error("음성 설치 파일 종류를 확인할 수 없습니다.");
  }
  return rows;
}
async function seal(directory: string, revision: string, archiveSha256?: string) {
  const files = await inventory(directory);
  if (!files.length) throw new Error("음성 설치 파일이 비어 있습니다.");
  const receipt: TreeReceipt = { revision, files, installedBytes: files.reduce((sum, file) => sum + file.bytes, 0), ...(archiveSha256 ? { archiveSha256 } : {}) };
  await writeFile(join(directory, receiptName), JSON.stringify(receipt), { mode: 0o600 });
}
async function verified(directory: string, revision: string, full = false): Promise<TreeReceipt | null> {
  try {
    if (!(await lstat(directory)).isDirectory()) return null;
    const receipt = JSON.parse(await readFile(join(directory, receiptName), "utf8")) as TreeReceipt;
    if (receipt.revision !== revision || !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 512) return null;
    for (const file of receipt.files) {
      if (typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) return null;
      const path = join(directory, file.path), rel = relative(directory, path);
      if (!rel || rel.startsWith(`..${sep}`) || rel === "..") return null;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size !== file.bytes || stat.mtimeMs !== file.mtimeMs) return null;
      if (full && await sha256(path) !== file.sha256) return null;
    }
    return receipt;
  } catch { return null; }
}
async function activate(staged: string, current: string) {
  const previous = `${current}.previous-${randomUUID()}`;
  let hadPrevious = false;
  try { await rename(current, previous); hadPrevious = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await rename(staged, current); }
  catch (error) { if (hadPrevious) await rename(previous, current); throw error; }
  if (hadPrevious) await rm(previous, { recursive: true, force: true });
}

/** Optional native/model installs are isolated from the application and never run npm scripts. */
export class VoiceModels {
  readonly root: string;
  readonly modelsDir: string;
  readonly runtimeNodeModules: string;
  private readonly runtimeDir: string;
  private readonly modelDir: string;
  private readonly downloads = new Map<string, Download>();
  private readonly packages = manifest.runtime.packages.filter(item => item.name === "sherpa-onnx-node" || item.name === `sherpa-onnx-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`);
  constructor(dataDir: string) {
    this.root = join(dataDir, "voice");
    this.modelsDir = join(this.root, "models");
    this.modelDir = join(this.modelsDir, "sherpa-onnx-whisper-base");
    this.runtimeDir = join(this.root, `runtime-${manifest.runtime.version}-${platform}`);
    this.runtimeNodeModules = join(this.runtimeDir, "node_modules");
  }
  async list(): Promise<VoiceModel[]> {
    const modelReceipt = await verified(this.modelDir, localModel.sha256!);
    const runtimeReceipt = await verified(this.runtimeDir, manifest.runtime.version);
    return manifest.models.map(model => {
      const task = this.downloads.get(model.id);
      const supported = model.online || (model.platforms.includes(platform) && this.packages.length === 2);
      const installed = model.online || !!(modelReceipt && runtimeReceipt);
      return { ...model, kind: model.kind as VoiceModel["kind"], languages: [...model.languages], platforms: [...model.platforms],
        supported, installed, installedBytes: model.online ? 0 : modelReceipt?.installedBytes ?? null,
        runtimeBytes: model.online ? 0 : this.packages.reduce((bytes, item) => bytes + item.installedBytes, 0),
        state: task?.active ? "downloading" : task?.error ? "error" : installed ? model.online ? "available" : "installed" : "missing",
        receivedBytes: task?.receivedBytes ?? 0, error: task?.error ?? null };
    });
  }
  async requireLocal() {
    if (!localModel.platforms.includes(platform) || this.packages.length !== 2) throw new VoiceModelError(409, "이 호스트 운영체제용 로컬 음성 런타임이 없습니다.");
    if (!await verified(this.modelDir, localModel.sha256!, true) || !await verified(this.runtimeDir, manifest.runtime.version, true)) {
      throw new VoiceModelError(409, "로컬 모델·런타임이 없거나 무결성 확인에 실패했습니다. 설정에서 명시적으로 다운로드해 주세요.");
    }
    return { modelsDir: this.modelsDir, runtimeNodeModules: this.runtimeNodeModules };
  }
  startDownload(id: string, accepted: boolean) {
    if (id !== "whisper-base") throw new VoiceModelError(400, "이 모델은 다운로드 대상이 아닙니다.");
    if (accepted !== true) throw new VoiceModelError(400, "모델·런타임 다운로드를 직접 선택해 주세요.");
    if (!localModel.platforms.includes(platform) || this.packages.length !== 2) throw new VoiceModelError(409, "이 호스트 운영체제용 로컬 음성 런타임이 없습니다.");
    if (this.downloads.get(id)?.active) return;
    const task: Download = { controller: new AbortController(), receivedBytes: 0, error: null, active: true };
    this.downloads.set(id, task);
    void this.install(task).catch(error => { task.error = task.controller.signal.aborted ? "다운로드를 취소했습니다. 기존 모델은 유지됩니다." : String(error instanceof Error ? error.message : error).slice(0, 500); }).finally(() => { task.active = false; });
  }
  cancelDownload(id: string) { this.downloads.get(id)?.controller.abort(); }
  close() { for (const task of this.downloads.values()) task.controller.abort(); }
  private async install(task: Download) {
    const signal = task.controller.signal;
    const staging = join(this.root, `.install-${randomUUID()}`);
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      if (!await verified(this.runtimeDir, manifest.runtime.version, true)) {
        const runtime = join(staging, "runtime");
        const archives: { name: string; version: string; integrity: string; sha256: string }[] = [];
        await mkdir(join(runtime, "node_modules"), { recursive: true });
        for (const pkg of this.packages) {
          signal.throwIfAborted();
          const archive = join(staging, `${pkg.name}.tgz`), extraction = join(staging, `${pkg.name}.extracting`);
          await downloadToFile({ url: pkg.url, outputPath: archive, expectedBytes: pkg.downloadBytes ?? 0, integrity: pkg.integrity, maximumBytes: 150_000_000, signal,
            onProgress: received => { task.receivedBytes = received; } });
          await extractTarArchive(archive, extraction, signal);
          await rename(join(extraction, "package"), join(runtime, "node_modules", pkg.name));
          archives.push({ name: pkg.name, version: pkg.version, integrity: pkg.integrity, sha256: await sha256(archive) });
          await rm(archive);
        }
        await writeFile(join(runtime, "archives.json"), JSON.stringify(archives), { mode: 0o600 });
        await seal(runtime, manifest.runtime.version);
        signal.throwIfAborted();
        await activate(runtime, this.runtimeDir);
      }
      if (!await verified(this.modelDir, localModel.sha256!, true)) {
        const directory = await ensureSherpaOnnxModel({ modelsDir: join(staging, "models"), modelId: "whisper-base", expectedSha256: localModel.sha256!, logger, signal,
          onProgress: event => { if (event.phase === "downloading") task.receivedBytes = event.receivedBytes; } });
        await seal(directory, localModel.sha256!, localModel.sha256!);
        await mkdir(this.modelsDir, { recursive: true, mode: 0o700 });
        signal.throwIfAborted();
        await activate(directory, this.modelDir);
      }
    } finally {
      // A staging tree is never accepted as installed. Failed/cancelled bytes cannot replace prior models.
      await rm(staging, { recursive: true, force: true });
    }
  }
}

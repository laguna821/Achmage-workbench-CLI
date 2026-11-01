import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import JSZip from "jszip";
import manifest from "../../../third_party/opendataloader/manifest.json" with { type: "json" };
import type { PdfExtractBlock, PdfExtractResult, PdfLoaderStatus } from "../../../packages/contracts/src/pdf-loader.ts";

type Asset = { name: string; url: string; sha256: string; size: number };
type Core = { java: string; jar: string; digest: string };
const builds: Record<string, { java: Asset; uv: Asset }> = manifest.platforms;
const read = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; } };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function find(root: string, name: string, depth = 5): string | null {
  if (!existsSync(root)) return null;
  for (const file of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, file.name);
    if (file.isFile() && file.name === name) return path;
    if (file.isDirectory() && depth > 0) { const hit = find(path, name, depth - 1); if (hit) return hit; }
  }
  return null;
}

/** Map the upstream JSON only; layout, reading order, tables and OCR remain upstream. */
export function extractedDocument(value: unknown, markdown = ""): PdfExtractResult {
  const blocks: PdfExtractBlock[] = [];
  const visit = (node: unknown, page = 1, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 24 || blocks.length > 100000) return;
    if (Array.isArray(node)) { for (const child of node) visit(child, page, depth + 1); return; }
    const item = node as Record<string, unknown>;
    const at = item["page number"];
    if (typeof at === "number" && Number.isSafeInteger(at) && at > 0) page = at;
    const text = item.content, box = item["bounding box"];
    if (typeof text === "string" && text.trim()) {
      blocks.push({ page, text, kind: String(item.type ?? "text"), box: Array.isArray(box) && box.length === 4 && box.every(n => typeof n === "number" && Number.isFinite(n)) ? box as PdfExtractBlock["box"] : null });
      return;
    }
    for (const child of Object.values(item)) if (child && typeof child === "object") visit(child, page, depth + 1);
  };
  visit(value);
  const pages = new Map<number, string[]>();
  for (const block of blocks) { const list = pages.get(block.page) ?? []; list.push(block.text); pages.set(block.page, list); }
  return { engine: "opendataloader", blocks, pages: [...pages].sort(([a], [b]) => a - b).map(([page, texts]) => ({ page, text: texts.join("\n\n") })), markdown };
}

/** Original releases installed on demand, for this app only. No system PATH or Python changes. */
export class PdfLoader {
  readonly root: string;
  private progress: Pick<PdfLoaderStatus, "state" | "message" | "percent"> = { state: "idle", message: null, percent: null };
  private installation: Promise<void> | null = null;
  private installing: AbortController | null = null;
  private readonly children = new Set<ChildProcess>();
  private server: { child: ChildProcess; url: string; ready: Promise<string> } | null = null;
  private startingServer: Promise<string> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private active = 0;
  private closed = false;
  private cache = new Map<string, PdfExtractResult>();
  constructor(dataDir: string) { this.root = join(dataDir, "pdf-loader", manifest.version); }
  private core() { const c = read<Core>(join(this.root, "core.json")); return c && c.digest === manifest.cli.sha256 && existsSync(c.java) && existsSync(c.jar) ? c : null; }
  private python() { const p = read<{ python: string; wheel: string }>(join(this.root, "ocr.json")); return p && p.wheel === manifest.wheel.sha256 && existsSync(p.python) ? p.python : null; }
  status(): PdfLoaderStatus { return { version: manifest.version, supported: !!builds[`${process.platform}-${process.arch}`], coreReady: !!this.core(), ocrReady: !!this.python(), ...this.progress }; }
  private environment(): NodeJS.ProcessEnv {
    const env = { ...process.env, UV_PYTHON_INSTALL_DIR: join(this.root, "python"), UV_PYTHON_BIN_DIR: join(this.root, "bin"), UV_CACHE_DIR: join(this.root, "cache"), UV_PYTHON_PREFERENCE: "only-managed", UV_PYTHON_INSTALL_REGISTRY: "false", UV_NO_CONFIG: "1", HF_HOME: join(this.root, "models", "huggingface"), EASYOCR_MODULE_PATH: join(this.root, "models", "easyocr"), HF_HUB_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", OMP_NUM_THREADS: "2", TOKENIZERS_PARALLELISM: "false", PYTHONUTF8: "1", PYTHONNOUSERSITE: "1" };
    for (const name of ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]) delete (env as NodeJS.ProcessEnv)[name];
    return env;
  }
  private run(command: string, args: string[], signal?: AbortSignal, timeout = 180000): Promise<string> {
    if (this.closed) return Promise.reject(new Error("PDF 도구가 종료되었습니다."));
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: this.root, env: this.environment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      this.children.add(child); let output = "", error = "", stopped = false;
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-2_000_000); });
      child.stderr.on("data", chunk => { error = (error + String(chunk)).slice(-8000); });
      const stop = () => { stopped = true; child.kill("SIGTERM"); };
      const timer = setTimeout(stop, timeout); signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", stop); this.children.delete(child); };
      child.once("error", err => { clean(); reject(err); });
      child.once("close", code => { clean(); if (stopped) reject(new DOMException("PDF 작업을 중단했습니다.", "AbortError")); else if (code === 0) resolve(output); else reject(new Error(/password|encrypted/i.test(error) ? "PDF 암호가 필요하거나 올바르지 않습니다." : `PDF 도구 실행 실패(${code}): ${error.slice(-1200) || "실행 파일을 확인해 주세요."}`)); });
    });
  }
  private async download(asset: Asset, directory: string, signal: AbortSignal) {
    const target = join(directory, asset.name);
    if (existsSync(target) && hash(readFileSync(target)) === asset.sha256) return target;
    const response = await fetch(asset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]) });
    if (!response.ok || !response.body) throw new Error(`PDF 도구를 받지 못했습니다(HTTP ${response.status}).`);
    const reader = response.body.getReader(), parts: Buffer[] = []; let size = 0;
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > asset.size) { await reader.cancel(); throw new Error("PDF 도구 다운로드 크기가 배포 정보와 다릅니다."); } parts.push(Buffer.from(chunk.value)); this.progress.percent = Math.min(99, Math.round(size / asset.size * 100)); }
    const bytes = Buffer.concat(parts);
    if (size !== asset.size || hash(bytes) !== asset.sha256) throw new Error("PDF 도구의 SHA-256이 공식 배포 정보와 다릅니다.");
    writeFileSync(target, bytes, { mode: 0o600 }); return target;
  }
  private async unpack(archive: string, dest: string, signal: AbortSignal) {
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    if (archive.endsWith(".zip")) {
      const zip = await JSZip.loadAsync(readFileSync(archive));
      for (const file of Object.values(zip.files)) {
        const target = resolve(dest, file.name);
        if (!target.startsWith(resolve(dest) + sep)) throw new Error("PDF 도구 압축 경로가 올바르지 않습니다.");
        if (file.dir) mkdirSync(target, { recursive: true });
        else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, await file.async("nodebuffer")); }
      }
    } else await this.run("tar", ["-xzf", archive, "-C", dest], signal);
  }
  install(kind: "core" | "ocr") {
    if (this.installation) return this.installation;
    const controller = this.installing = new AbortController();
    this.installation = this.installOriginal(kind, controller.signal).catch(error => { this.progress = { state: "error", message: error instanceof Error ? error.message : String(error), percent: null }; }).finally(() => { this.installation = null; this.installing = null; });
    return this.installation;
  }
  cancelInstall() { this.installing?.abort(); }
  private async installOriginal(kind: "core" | "ocr", signal: AbortSignal) {
    const build = builds[`${process.platform}-${process.arch}`]; if (!build) throw new Error("이 OS/CPU용 PDF 도구 배포판이 없습니다.");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const downloads = join(this.root, "downloads"); mkdirSync(downloads, { recursive: true, mode: 0o700 });
    const phase = (message: string) => { this.progress = { state: "installing", message, percent: null }; };
    if (!this.core()) {
      phase("PDF 추출 엔진 받는 중…"); const cli = await this.download(manifest.cli, downloads, signal);
      phase("PDF 전용 Java 받는 중…"); const javaArchive = await this.download(build.java, downloads, signal);
      phase("PDF 추출 엔진 준비 중…");
      await this.unpack(cli, join(this.root, "cli"), signal); await this.unpack(javaArchive, join(this.root, "java"), signal);
      const java = find(join(this.root, "java"), process.platform === "win32" ? "java.exe" : "java");
      const jar = find(join(this.root, "cli"), `opendataloader-pdf-cli-${manifest.version}.jar`);
      if (!java || !jar) throw new Error("PDF 실행 파일을 찾지 못했습니다.");
      await this.run(java, ["-Djava.awt.headless=true", "-jar", jar, "--export-options"], signal);
      writeFileSync(join(this.root, "core.json.tmp"), JSON.stringify({ java, jar, digest: manifest.cli.sha256 })); renameSync(join(this.root, "core.json.tmp"), join(this.root, "core.json"));
    }
    if (kind === "ocr" && !this.python()) {
      phase("스캔 PDF 인식 도구 준비 중…"); const uvArchive = await this.download(build.uv, downloads, signal);
      await this.unpack(uvArchive, join(this.root, "uv"), signal);
      const uv = find(join(this.root, "uv"), process.platform === "win32" ? "uv.exe" : "uv"); if (!uv) throw new Error("Python 설치 도구를 찾지 못했습니다.");
      phase("앱 전용 Python 설치 중…"); await this.run(uv, ["python", "install", manifest.pythonVersion, "--no-progress"], signal, 600000);
      const venv = join(this.root, "ocr-env");
      await this.run(uv, ["venv", "--python", manifest.pythonVersion, "--allow-existing", venv], signal);
      const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      phase("OpenDataLoader OCR 패키지 받는 중…"); const wheel = await this.download(manifest.wheel, downloads, signal);
      phase("한국어·영어 OCR 패키지 설치 중… 용량에 따라 시간이 걸릴 수 있습니다.");
      await this.run(uv, ["pip", "install", "--python", python, "--torch-backend=cpu", "--no-progress", `${wheel}[hybrid]`], signal, 1200000);
      const version = await this.run(python, ["-c", "import importlib.metadata; print(importlib.metadata.version('opendataloader-pdf'))"], signal);
      if (version.trim() !== manifest.version) throw new Error("OCR 원본 버전이 일치하지 않습니다.");
      phase("한국어·영어 OCR 모델 준비 중…");
      await this.startServer(python, signal);
      writeFileSync(join(this.root, "ocr.json.tmp"), JSON.stringify({ python, wheel: manifest.wheel.sha256 })); renameSync(join(this.root, "ocr.json.tmp"), join(this.root, "ocr.json"));
      writeFileSync(join(this.root, "ocr-packages.txt"), await this.run(uv, ["pip", "freeze", "--python", python], signal));
      this.armIdle();
    }
    this.progress = { state: "idle", message: kind === "ocr" ? "PDF 추출·한국어/영어 OCR 준비 완료" : "PDF 본문·표·그림 추출 준비 완료", percent: 100 };
    rmSync(downloads, { recursive: true, force: true }); rmSync(join(this.root, "cache"), { recursive: true, force: true });
  }
  private async startServer(python: string, signal?: AbortSignal): Promise<string> {
    if (this.server) return this.server.ready;
    if (this.startingServer) return this.startingServer;
    this.startingServer = this.launchServer(python, signal).finally(() => { this.startingServer = null; });
    return this.startingServer;
  }
  private async launchServer(python: string, signal?: AbortSignal): Promise<string> {
    const port = await new Promise<number>((resolve, reject) => { const s = createServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(python, ["-m", "opendataloader_pdf.hybrid_server", "--host", "127.0.0.1", "--port", String(port), "--device", "cpu", "--ocr-lang", "ko,en"], { cwd: this.root, env: this.environment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child); let diagnostic = "", exited = false;
    child.stdout.resume(); child.stderr.setEncoding("utf8"); child.stderr.on("data", text => { diagnostic = (diagnostic + String(text)).slice(-2000); });
    child.once("error", error => { diagnostic = error.message; exited = true; });
    child.once("exit", () => { exited = true; this.children.delete(child); if (this.server?.child === child) this.server = null; });
    const stop = () => child.kill("SIGTERM"); signal?.addEventListener("abort", stop, { once: true });
    const ready = (async () => {
      try {
        const deadline = Date.now() + 900000;
        while (Date.now() < deadline && !signal?.aborted && !this.closed) {
          if (exited) throw new Error(`OCR 준비 실패: ${diagnostic.slice(-1000)}`);
          try { const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) }); if (res.ok && !exited) return url; } catch { /* Owned server is starting; models may be downloading. */ }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error(signal?.aborted ? "OCR 준비를 중단했습니다." : "OCR 모델 준비 시간이 초과되었습니다.");
      } catch (error) { stop(); throw error; }
      finally { signal?.removeEventListener("abort", stop); }
    })();
    this.server = { child, url, ready }; return ready;
  }
  private armIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (this.active === 0) this.server?.child.kill("SIGTERM"); else this.armIdle(); }, 180000); this.idle.unref();
  }
  async extract(bytes: Uint8Array, options: { pages?: number[]; password?: string; ocr?: boolean; images?: boolean; signal?: AbortSignal } = {}): Promise<PdfExtractResult> {
    const core = this.core(); if (!core) throw new Error("PDF 추출·OCR 설정에서 OpenDataLoader를 먼저 설치해 주세요.");
    if (bytes.length > 200_000_000 || !Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new Error("PDF 파일이 올바르지 않습니다.");
    if (options.pages && (options.pages.length > 20000 || options.pages.some(p => !Number.isSafeInteger(p) || p < 1))) throw new Error("PDF 페이지 범위가 올바르지 않습니다.");
    const key = hash(bytes) + JSON.stringify([options.pages, options.ocr, options.images]);
    // Password-protected documents are never cached across calls/password attempts.
    const cached = options.password === undefined ? this.cache.get(key) : null; if (cached) return cached;
    const job = mkdtempSync(join(this.root, "job-")); this.active++;
    try {
      const input = join(job, "input.pdf"); writeFileSync(input, bytes, { mode: 0o600 });
      const args = ["-Djava.awt.headless=true", "-Dapple.awt.UIElement=true", "-Xmx768m", "-jar", core.jar, input, "--format", "json,markdown", "--output-dir", job, "--include-header-footer", "--image-output", options.images ? "embedded" : "off", "--quiet"];
      if (options.pages?.length) args.push("--pages", options.pages.join(","));
      if (options.password !== undefined) args.push("--password", options.password);
      if (options.ocr) {
        const python = this.python(); if (!python) throw new Error("PDF 추출·OCR 설정에서 한국어·영어 OCR을 설치해 주세요.");
        const url = await this.startServer(python, options.signal); args.push("--hybrid", "docling-fast", "--hybrid-mode", "full", "--hybrid-url", url, "--hybrid-timeout", "180000");
      }
      await this.run(core.java, args, options.signal, options.ocr ? 300000 : 180000);
      const json = readFileSync(join(job, "input.json")), md = readFileSync(join(job, "input.md"), "utf8");
      if (json.length + md.length > 64_000_000) throw new Error("추출 결과가 큽니다. 페이지 범위를 나눠 주세요.");
      const result = extractedDocument(JSON.parse(json.toString("utf8")), md);
      if (options.password === undefined && md.length < 1_000_000) { this.cache.set(key, result); while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!); }
      return result;
    } finally { this.active--; rmSync(job, { recursive: true, force: true }); this.armIdle(); }
  }
  async close() { this.closed = true; this.cancelInstall(); if (this.idle) clearTimeout(this.idle); await Promise.all([...this.children].map(child => new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGTERM"); }))); await this.installation; this.cache.clear(); }
}

const instances = new Map<string, PdfLoader>();
export function pdfLoader(dataDir: string) { let instance = instances.get(dataDir); if (!instance) instances.set(dataDir, instance = new PdfLoader(dataDir)); return instance; }

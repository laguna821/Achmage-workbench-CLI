import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./errors.ts";

// Word, PowerPoint and Excel documents through the `ieumoffice` command line tool that ships
// inside an installed IeumOffice (https://github.com/pblsketch/openoffice, Apache-2.0). The tool
// is called, never vendored: page previews, a text view for reading, and the checks engines run.
// Engines edit a working copy with the same tool; the gateway only reads and renders.

const run = promisify(execFile);

export type OfficePage = { page: number; width: number; height: number; file: string };
type CliResult = { status: "ok" | "error" | "partial"; command?: string; summary?: string; output_path?: string; detail?: Record<string, unknown>; code?: number; error?: string; message?: string };

/** Where Workbench installs IeumOffice for the current user (one folder per version, `current` points at one). */
export const IEUM_HOME = join(homedir(), ".local/opt/ieumoffice");

/** The `ieumoffice` launcher: an override, the app's own record, Workbench's install, a system install, PATH. */
export function findIeumCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env.WORKBENCH_IEUM_CLI) candidates.push(env.WORKBENCH_IEUM_CLI);
  try {
    // Every IeumOffice launch writes the folder of its launcher here.
    const recorded = readFileSync(join(homedir(), ".ieumoffice/launcher"), "utf8").trim();
    if (recorded) candidates.push(join(recorded, "ieumoffice"));
  } catch {
    // Not launched on this account yet.
  }
  candidates.push(join(IEUM_HOME, "current/resources/cli/ieumoffice"), "/opt/IeumOffice/resources/cli/ieumoffice", "/usr/lib/ieumoffice/resources/cli/ieumoffice");
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) candidates.push(join(dir, "ieumoffice"));
  return candidates.find((path) => existsSync(path)) ?? null;
}

export class IeumOffice {
  readonly cli: string | null;
  private versionCache: Promise<string | null> | null = null;

  constructor(cli = findIeumCli()) {
    this.cli = cli;
  }

  get available() {
    return Boolean(this.cli);
  }

  version(): Promise<string | null> {
    if (!this.cli) return Promise.resolve(null);
    this.versionCache ??= run(this.cli, ["--version"], { timeout: 30_000, env: this.env([]) })
      .then(({ stdout }) => stdout.trim().split(/\s+/).pop() ?? null)
      .catch(() => null);
    return this.versionCache;
  }

  /** The tool may read and write only inside `roots`; its own command log is off (Workbench keeps revisions). */
  private env(roots: string[]): NodeJS.ProcessEnv {
    return { ...process.env, GENOFFICE_ALLOWED_ROOTS: roots.join(delimiter), GENOFFICE_AUDIT_LOG: "off" };
  }

  /** One command with `--json`; refusals become HTTP errors with the tool's own message. */
  async run(args: string[], roots: string[], timeoutMs = 180_000): Promise<CliResult> {
    if (!this.cli) throw new HttpError(501, "ieumoffice_missing", "이음오피스가 설치되어 있지 않아 이 문서를 열 수 없습니다. 연결 설정에서 설치하세요.");
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(this.cli!, [...args, "--json"], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: this.env(roots) }, (error, out, err) =>
        // A failed command still prints its JSON on stdout.
        out?.trim() ? resolve(out) : reject(new HttpError(500, "ieumoffice_failed", `이음오피스 실행 실패: ${(err || error?.message || "").toString().slice(0, 300)}`)),
      ),
    );
    let result: CliResult;
    try {
      result = JSON.parse(stdout.slice(stdout.indexOf("{"))) as CliResult;
    } catch {
      throw new HttpError(500, "ieumoffice_failed", "이음오피스 응답을 읽지 못했습니다.");
    }
    if (result.status === "error") throw new HttpError(422, result.error ?? "ieumoffice_error", result.message ?? "이음오피스가 요청을 처리하지 못했습니다.");
    return result;
  }

  /** One PNG per page (144 dpi) into `outDir`, as IeumOffice lays the document out. */
  async render(input: string, outDir: string): Promise<OfficePage[]> {
    mkdirSync(outDir, { recursive: true });
    const result = await this.run(["render", input, "--out", outDir, "--scale", "2"], [dirname(input), outDir]);
    const files = ((result.detail?.files as { page: number; path: string; width: number; height: number }[] | undefined) ?? []).map((entry) => ({
      page: entry.page,
      width: entry.width,
      height: entry.height,
      file: entry.path,
    }));
    return files.sort((a, b) => a.page - b.page);
  }

  /** What an engine or a person reads: Markdown for Word, slide texts for PowerPoint, tables for Excel. */
  async textView(input: string, format: "docx" | "pptx" | "xlsx"): Promise<string> {
    if (format === "docx") {
      const dir = mkdtempSync(join(tmpdir(), "workbench-ieum-md-"));
      try {
        const out = join(dir, "view.md");
        await this.run(["convert", input, "--to", "md", "--out", out], [dirname(input), dir]);
        return readFileSync(out, "utf8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    if (format === "pptx") {
      const result = await this.run(["slides", "read", input, "--full"], [dirname(input)]);
      const pages = (result.detail?.pages as { index: number; elements?: { text?: string; type?: string; table?: unknown }[]; notes?: string }[] | undefined) ?? [];
      return pages
        .map((page) => {
          const texts = (page.elements ?? []).map((element) => element.text?.trim()).filter((text): text is string => Boolean(text));
          const notes = page.notes?.trim() ? `\n\n> 발표자 노트: ${page.notes.trim()}` : "";
          return `## ${page.index + 1}번 슬라이드\n\n${texts.join("\n\n") || "(글 없음)"}${notes}`;
        })
        .join("\n\n");
    }
    const stats = await this.run(["sheet", "read", input, "--stats"], [dirname(input)]);
    const sheets = (((stats.detail?.stats as { sheets?: { name: string }[] } | undefined)?.sheets ?? []).map((sheet) => sheet.name)).slice(0, 8);
    const parts: string[] = [];
    for (const sheet of sheets.length ? sheets : [null]) {
      const result = await this.run(["sheet", "read", input, ...(sheet ? ["--sheet", sheet] : []), "--max-rows", "200"], [dirname(input)]);
      const rows = (result.detail?.rows as unknown[][] | undefined) ?? [];
      const name = (result.detail?.sheet as string | undefined) ?? sheet ?? "시트";
      const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
      const width = Math.max(1, ...rows.map((row) => row.length));
      const table = rows.length
        ? [rows[0], Array(width).fill("---"), ...rows.slice(1)].map((row) => `| ${Array.from({ length: width }, (_, index) => cell(row[index])).join(" | ")} |`).join("\n")
        : "(빈 시트)";
      const more = result.detail?.truncated ? `\n\n…(${String(result.detail.rowsTotal ?? "")}행 중 일부)` : "";
      parts.push(`## ${name}\n\n${table}${more}`);
    }
    return parts.join("\n\n");
  }

  /** The agent instructions IeumOffice ships for its tool (SKILL.md), when present. */
  skillPath(): string | null {
    if (!this.cli) return null;
    const path = join(dirname(this.cli), "skills/ieumoffice/SKILL.md");
    return existsSync(path) ? path : null;
  }
}

// ---- Installing IeumOffice for the current user ------------------------------------------------

export type InstallProgress = { stage: "download" | "verify" | "extract" | "done" | "error"; message: string; version?: string };

type ReleaseAsset = { name: string; browser_download_url: string; size: number };

/**
 * Download the latest Linux AppImage of IeumOffice from its GitHub releases, check it against the
 * SHA-512 the release publishes, unpack it without running it, and point `current` at it.
 * Nothing is installed system-wide and the previous version stays until the new one is ready.
 */
export async function installIeumOffice(progress: (step: InstallProgress) => void): Promise<string> {
  if (process.platform !== "linux") throw new HttpError(501, "unsupported_platform", "자동 설치는 아직 Linux만 지원합니다. 이음오피스 누리집에서 설치해 주세요.");
  const release = (await (await fetch("https://api.github.com/repos/pblsketch/openoffice/releases/latest", { headers: { accept: "application/vnd.github+json" } })).json()) as {
    tag_name?: string;
    assets?: ReleaseAsset[];
  };
  const version = release.tag_name?.replace(/^v/, "");
  const appImage = release.assets?.find((asset) => asset.name.endsWith(".AppImage"));
  const manifest = release.assets?.find((asset) => asset.name === "latest-linux.yml");
  if (!version || !appImage || !manifest) throw new HttpError(502, "release_unavailable", "이음오피스 배포판 정보를 받지 못했습니다.");
  const target = join(IEUM_HOME, version);
  // Staged next to the install so the final move is a rename on the same file system.
  mkdirSync(IEUM_HOME, { recursive: true });
  const work = mkdtempSync(join(IEUM_HOME, ".staging-"));
  try {
    progress({ stage: "download", message: `이음오피스 ${version} 내려받는 중 (${Math.round(appImage.size / 1048576)}MB)…`, version });
    const yml = await (await fetch(manifest.browser_download_url)).text();
    const response = await fetch(appImage.browser_download_url);
    if (!response.ok || !response.body) throw new HttpError(502, "download_failed", "내려받기에 실패했습니다.");
    const file = join(work, appImage.name);
    const hash = createHash("sha512");
    const { createWriteStream } = await import("node:fs");
    const { Readable, Transform } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(file),
    );

    progress({ stage: "verify", message: "배포판 체크섬(SHA-512) 확인 중…", version });
    const expected = new RegExp(`url: ${appImage.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+sha512: (\\S+)`).exec(yml)?.[1];
    const actual = hash.digest("base64");
    if (!expected || expected !== actual) throw new HttpError(502, "checksum_mismatch", "내려받은 파일이 배포판 체크섬과 맞지 않아 설치하지 않았습니다.");

    progress({ stage: "extract", message: "풀어서 설치하는 중…", version });
    const staging = join(work, "root");
    await extractAppImage(file, staging);
    if (!existsSync(join(staging, "resources/cli/ieumoffice"))) throw new HttpError(500, "extract_failed", "설치 파일 안에서 명령줄 도구를 찾지 못했습니다.");
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    const link = join(IEUM_HOME, "current");
    const temporary = `${link}.${process.pid}`;
    symlinkSync(target, temporary);
    renameSync(temporary, link);
    progress({ stage: "done", message: `이음오피스 ${version} 설치를 마쳤습니다.`, version });
    return join(link, "resources/cli/ieumoffice");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Unpack an AppImage's squashfs with `unsquashfs` (no code from the image runs); fall back to its own extractor. */
async function extractAppImage(file: string, into: string) {
  const header = readFileSync(file).subarray(0, 4 * 1024 * 1024);
  let offset = -1;
  for (let index = header.indexOf("hsqs"); index >= 0; index = header.indexOf("hsqs", index + 1)) {
    const blockSize = header.readUInt32LE(index + 12);
    if (blockSize >= 4096 && blockSize <= 1048576 && (blockSize & (blockSize - 1)) === 0) {
      offset = index;
      break;
    }
  }
  const unsquashfs = ["/usr/bin/unsquashfs", "/usr/sbin/unsquashfs", "/bin/unsquashfs"].find((path) => existsSync(path));
  if (unsquashfs && offset > 0) {
    await run(unsquashfs, ["-q", "-n", "-o", String(offset), "-d", into, file], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    return;
  }
  // Without squashfs tools the AppImage unpacks itself (its runtime only extracts).
  const cwd = dirname(into);
  const { chmodSync } = await import("node:fs");
  chmodSync(file, 0o755);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, ["--appimage-extract"], { cwd, stdio: "ignore" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new HttpError(500, "extract_failed", "설치 파일을 풀지 못했습니다."))));
    child.on("error", reject);
  });
  renameSync(join(cwd, "squashfs-root"), into);
}

/** Versions Workbench has installed (folders next to `current`). */
export function installedVersions(): string[] {
  try {
    return readdirSync(IEUM_HOME).filter((name) => name !== "current" && statSync(join(IEUM_HOME, name)).isDirectory());
  } catch {
    return [];
  }
}

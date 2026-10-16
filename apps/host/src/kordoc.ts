import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors.ts";

// Hangul documents through the user's installed kordoc engine (hallym-kordoc skill runner):
// read HWPX/HWP into a Markdown view, patch edited Markdown back into the same HWPX (keeping the
// original formatting of untouched parts), and render real page previews. HWP is read only.
// The PRD's HOP editor is the target for full in-place editing; this is the engine available now.

type KordocResult = {
  status: "success" | "partial" | "failed";
  success: boolean;
  files?: { path: string; bytes: number }[];
  warnings?: unknown[];
  skipped?: { edits?: unknown[]; fields?: unknown[] };
  data?: Record<string, unknown>;
  failure?: { code: string; message: string } | null;
};

export type HangulPage = { page: number; width: number; height: number; svg: string };

export function findKordocRunner(): string | null {
  const candidates = [process.env.WORKBENCH_KORDOC_RUNNER, join(homedir(), ".claude/skills/hallym-kordoc/scripts/run.mjs")].filter(
    (path): path is string => Boolean(path),
  );
  return candidates.find((path) => existsSync(path)) ?? null;
}

export class Kordoc {
  readonly runner: string | null;

  constructor(runner = findKordocRunner()) {
    this.runner = runner;
  }

  get available() {
    return Boolean(this.runner);
  }

  private async run(job: Record<string, unknown>): Promise<{ result: KordocResult; dir: string }> {
    if (!this.runner) throw new HttpError(501, "kordoc_missing", "한글 문서 엔진(kordoc)이 설치되어 있지 않아 HWPX를 열 수 없습니다.");
    const dir = mkdtempSync(join(tmpdir(), "workbench-kordoc-"));
    const requestPath = join(dir, "request.json");
    writeFileSync(requestPath, JSON.stringify({ schemaVersion: 1, ...job, outputDir: join(dir, "out") }));
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(process.execPath, [this.runner!, requestPath], { cwd: dir, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, KORDOC_OFFLINE: "1" } }, (error, out) =>
        // Exit code 2 means "partial"; the JSON tells what happened.
        error && !out ? reject(new HttpError(500, "kordoc_failed", `한글 엔진 실행 실패: ${error.message}`)) : resolve(out),
      ),
    );
    let result: KordocResult;
    try {
      result = JSON.parse(stdout) as KordocResult;
    } catch {
      rmSync(dir, { recursive: true, force: true });
      throw new HttpError(500, "kordoc_failed", "한글 엔진 응답을 읽지 못했습니다.");
    }
    return { result, dir };
  }

  /** Markdown view of a Hangul file (tables kept as tables, for round-trip editing). */
  async read(input: string): Promise<string> {
    const { result, dir } = await this.run({ mode: "read", input, options: { layoutTables: "keep" } });
    try {
      if (!result.success) throw new HttpError(422, result.failure?.code ?? "kordoc_read_failed", result.failure?.message ?? "한글 문서를 읽지 못했습니다.");
      const markdown = (result.data?.markdown as string | undefined) ?? readFileSync(join(dir, "out", "document.md"), "utf8");
      return markdown;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * Apply an edited Markdown view to the original HWPX. Only a complete patch is accepted: when
   * the engine skips any edit (added paragraphs, mixed formatting…), nothing is written.
   */
  async patch(input: string, markdown: string): Promise<Buffer> {
    const dir = mkdtempSync(join(tmpdir(), "workbench-kordoc-md-"));
    const markdownFile = join(dir, "edited.md");
    writeFileSync(markdownFile, markdown);
    try {
      const { result, dir: out } = await this.run({ mode: "patch", input, markdownFile });
      try {
        const skipped = [...(result.skipped?.edits ?? []), ...(result.skipped?.fields ?? [])];
        if (result.status !== "success" || skipped.length) {
          const detail = skipped.length ? ` 반영하지 못한 편집 ${skipped.length}건: ${JSON.stringify(skipped).slice(0, 300)}` : "";
          throw new HttpError(422, result.failure?.code ?? "hwpx_patch_partial", `HWPX에 그대로 반영할 수 없는 편집이 있어 원본을 유지했습니다.${detail}`);
        }
        const file = result.files?.find((entry) => entry.path.endsWith(".hwpx"))?.path;
        if (!file) throw new HttpError(500, "kordoc_failed", "고친 HWPX를 찾지 못했습니다.");
        return readFileSync(file);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Real page previews (SVG) with region ids for paragraphs and tables. */
  async render(input: string): Promise<HangulPage[]> {
    const { result, dir } = await this.run({ mode: "render", input, format: "svg" });
    try {
      if (!result.success) throw new HttpError(422, result.failure?.code ?? "kordoc_render_failed", result.failure?.message ?? "미리보기를 만들지 못했습니다.");
      const pages = (result.data?.pages as { page: number; width: number; height: number }[] | undefined) ?? [];
      const files = readdirSync(join(dir, "out")).filter((name) => name.endsWith(".svg"));
      return pages.map((page) => ({
        ...page,
        svg: readFileSync(join(dir, "out", files.find((name) => name === `preview-${page.page}.svg`) ?? files[page.page - 1]), "utf8"),
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

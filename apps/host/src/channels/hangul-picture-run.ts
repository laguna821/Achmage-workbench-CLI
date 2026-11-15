import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../resources.ts";

// The first page of a Hangul document as a PNG, made in a short-lived child process
// (hangul-picture-job): drawing the page (rhwp) and rasterizing it (resvg) take about half a second
// and some hundred MB of WASM memory and fonts that would otherwise hold up and stay in the
// gateway. The gateway itself never draws a page for the chat. Bounded in time, one at a time, and
// the child sees only the few variables it needs.

/**
 * Why there is no picture, as a short code (never the child's own words, which could name the
 * document): `render` the page could not be drawn; `raster` it was drawn (its SVG is beside the
 * PNG's place) but not rasterized; `timeout` / `exited` / `spawn` the child ran too long, died, or
 * did not start; `busy` too many were waiting; `no-job` the job file is missing; `failed` anything else.
 */
export type PictureCode = "render" | "raster" | "timeout" | "exited" | "spawn" | "busy" | "no-job" | "failed" | "missing";
export type PictureResult = { ok: true; renderMs: number; rasterMs: number; fontBytes: number; rss: number } | { ok: false; code: PictureCode };

const CODES = new Set<string>(["render", "raster", "timeout", "exited", "spawn", "busy", "no-job", "failed", "missing"]);
/** Any answer as a known code: what is not one is `failed`. */
export function pictureCode(value: unknown): PictureCode {
  return typeof value === "string" && CODES.has(value) ? (value as PictureCode) : "failed";
}

export const PICTURE_TIMEOUT = 20_000;
/** The child's own limit: a little more than the parent's, for when the parent cannot kill it. */
export const PICTURE_CHILD_LIMIT = PICTURE_TIMEOUT + 5_000;
/** Pictures wait for the one child that runs; more than this many waiting are skipped (`busy`). */
export const PICTURE_WAITING = 2;

/** Where the child writes the page's SVG, before it rasterizes it to `out`. */
export function pictureSvg(out: string): string {
  return out.replace(/\.png$/i, "") + ".svg";
}

/**
 * The child's whole environment. Fonts are found through the desktop app's font list
 * (`WORKBENCH_APP_BIN`) or fontconfig (`fc-list` on PATH, which reads the home and XDG folders);
 * shipped files through `WORKBENCH_RESOURCES_DIR`; Windows needs its system folders. No token,
 * vault, engine or session variable, and no NODE_OPTIONS.
 */
const PASSED = [
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP",
  "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "FONTCONFIG_FILE", "FONTCONFIG_PATH",
  "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "USERPROFILE", "LOCALAPPDATA",
  "WORKBENCH_RESOURCES_DIR", "WORKBENCH_APP_BIN",
] as const;
export function pictureEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const passed: NodeJS.ProcessEnv = {};
  for (const name of PASSED) if (env[name] !== undefined) passed[name] = env[name];
  return passed;
}

export function pictureJobEntry(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // Beside host.mjs in the gateway bundle; the source file in a checkout.
  const bundled = join(here, "hangul-picture-job.mjs");
  if (existsSync(bundled)) return bundled;
  const root = repoRoot();
  const source = root ? join(root, "apps/host/src/hangul-picture-job.ts") : null;
  return source && existsSync(source) ? source : null;
}

let running: Promise<unknown> = Promise.resolve();
/** The one running and those waiting. */
let waiting = 0;

/** One picture, after the one before it: never several 300–450 MB children at once. */
export function hangulPicture(path: string, format: string, out: string, options: { timeoutMs?: number; entry?: string } = {}): Promise<PictureResult> {
  if (waiting >= PICTURE_WAITING + 1) return Promise.resolve({ ok: false, code: "busy" });
  waiting += 1;
  const turn = running.then(() => runChild(path, format, out, options)).finally(() => { waiting -= 1; });
  running = turn.catch(() => undefined);
  return turn;
}

function runChild(path: string, format: string, out: string, { timeoutMs = PICTURE_TIMEOUT, entry = pictureJobEntry() }: { timeoutMs?: number; entry?: string | null }): Promise<PictureResult> {
  if (!entry) return Promise.resolve({ ok: false, code: "no-job" });
  return new Promise((done) => {
    let child: ReturnType<typeof fork>;
    try {
      child = fork(entry, [String(timeoutMs + PICTURE_CHILD_LIMIT - PICTURE_TIMEOUT)], { execArgv: [], env: pictureEnv(), stdio: ["ignore", "ignore", "pipe", "ipc"] });
    } catch {
      return done({ ok: false, code: "spawn" });
    }
    // Diagnostics are drained, never logged (they could name the document).
    child.stderr?.resume();
    let settled = false;
    const finish = (result: PictureResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      done(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: "timeout" }), timeoutMs);
    child.once("message", (message) => {
      const answer = message as { ok?: unknown; code?: unknown; renderMs?: unknown; rasterMs?: unknown; fontBytes?: unknown; rss?: unknown };
      finish(answer.ok === true
        ? { ok: true, renderMs: Number(answer.renderMs) || 0, rasterMs: Number(answer.rasterMs) || 0, fontBytes: Number(answer.fontBytes) || 0, rss: Number(answer.rss) || 0 }
        : { ok: false, code: pictureCode(answer.code) });
    });
    child.once("error", () => finish({ ok: false, code: "spawn" }));
    child.once("exit", () => finish({ ok: false, code: "exited" }));
    child.send({ path, format, out, svg: pictureSvg(out) });
  });
}

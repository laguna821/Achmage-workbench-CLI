import { fork, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as pages from "../hwp-pages.mjs";
import { hangulPicture, PICTURE_WAITING, pictureEnv, pictureJobEntry, pictureSvg } from "./hangul-picture-run.ts";
import { cleanKits, pair, say, settle, startKit, type Kit } from "./test-kit.ts";

// Re-review 2, fix round 3 (R5 and the picture minors): the gateway never draws a Hangul page
// itself. The child writes the page's SVG before it rasterizes; the gateway sends that file if the
// child left it, and otherwise no picture at all (the original still goes, the record has a code).

vi.mock("../hwp-pages.mjs", async (original) => {
  const real = await original<typeof import("../hwp-pages.mjs")>();
  return { ...real, hangulFirstPage: vi.fn(real.hangulFirstPage) };
});

afterEach(() => { cleanKits(); });

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "강의계획서.hwpx");
const scratch = mkdtempSync(join(tmpdir(), "wb-picture-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function hangulTurn(kit: Kit) {
  await say(kit, "강의계획서 만들어 줘");
  const { sessionId } = kit.engine.sent.at(-1)!;
  const workId = kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId;
  copyFileSync(FIXTURE, join(kit.manager.workCwd(workId), "강의계획서.hwpx"));
  const artifact = kit.manager.openFile(workId, "강의계획서.hwpx");
  kit.manager.sink.upsertItem(sessionId, { kind: "artifact", id: "artifact:1", artifactId: artifact.id, revision: artifact.revision, change: "created", at: Date.now() });
  kit.engine.say(sessionId, "강의계획서를 만들었습니다.");
  kit.engine.finish(sessionId);
  await settle(kit);
  return kit.adapter.last()!;
}

const fallbacks = (kit: Kit) => kit.core.auditList().filter((row) => row.action === "preview.fallback").map((row) => row.result);

describe("a picture child that stops before it wrote anything (R5)", () => {
  for (const code of ["timeout", "exited"] as const) {
    it(`(${code}): the gateway draws nothing itself, the original goes once, and the record has the code`, async () => {
      const kit = await startKit();
      const drawn = vi.mocked(pages.hangulFirstPage);
      drawn.mockClear();
      kit.core.rasterize = async () => ({ ok: false, code });
      await pair(kit);
      const answer = await hangulTurn(kit);
      expect(drawn).not.toHaveBeenCalled();
      expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["강의계획서.hwpx"]);
      expect(answer.out.text).toBe("강의계획서를 만들었습니다.");
      expect(fallbacks(kit)).toEqual([code]);
    }, 30_000);
  }

  it("records only a short code, never what the child said", async () => {
    const kit = await startKit();
    kit.core.rasterize = async () => ({ ok: false, error: "ENOENT: /home/someone/비밀 문서.hwpx" }) as never;
    await pair(kit);
    await hangulTurn(kit);
    expect(fallbacks(kit)).toEqual(["failed"]);
  }, 30_000);
});

describe("a picture child that wrote the page and then could not rasterize it (R5)", () => {
  it("sends the SVG the child wrote, and nothing the gateway drew", async () => {
    const kit = await startKit();
    const drawn = vi.mocked(pages.hangulFirstPage);
    drawn.mockClear();
    const page = "<svg xmlns='http://www.w3.org/2000/svg' data-by='child'/>";
    kit.core.rasterize = async (_path, _format, out) => { writeFileSync(pictureSvg(out), page); return { ok: false, code: "raster" }; };
    await pair(kit);
    await hangulTurn(kit);
    expect(drawn).not.toHaveBeenCalled();
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["강의계획서.hwpx", "강의계획서 1쪽.svg"]);
    expect(kit.adapter.uploads[1]!.bytes.toString()).toBe(page);
    expect(fallbacks(kit)).toEqual(["raster"]);
  }, 30_000);
});

describe("the picture child itself", () => {
  const job = (name: string, body: string) => { const path = join(scratch, `${name}.mjs`); writeFileSync(path, body); return path; };

  it("writes the page's SVG before the PNG", async () => {
    const out = join(scratch, "page.png");
    const made = await hangulPicture(FIXTURE, "hwpx", out);
    expect(made.ok).toBe(true);
    expect(readFileSync(pictureSvg(out), "utf8")).toMatch(/^<svg/);
    expect(readFileSync(out).subarray(0, 4).toString("hex")).toBe("89504e47");
  }, 30_000);

  it("answers with a code when the child hangs, dies, or says something else", async () => {
    const hang = job("hang", "process.once('message', () => setInterval(() => {}, 1000));");
    const dies = job("dies", "process.once('message', () => process.exit(3));");
    const talks = job("talks", "process.once('message', () => process.send({ ok: false, error: 'ENOENT: /home/someone/a.hwpx' }));");
    expect(await hangulPicture(FIXTURE, "hwpx", join(scratch, "a.png"), { entry: hang, timeoutMs: 300 })).toEqual({ ok: false, code: "timeout" });
    expect(await hangulPicture(FIXTURE, "hwpx", join(scratch, "b.png"), { entry: dies })).toEqual({ ok: false, code: "exited" });
    expect(await hangulPicture(FIXTURE, "hwpx", join(scratch, "c.png"), { entry: talks })).toEqual({ ok: false, code: "failed" });
  });

  it("runs one child at a time; past the waiting cap a request is skipped as busy", async () => {
    // Each fake job writes when it ran, then answers after 150 ms.
    const slow = job("slow", "import { writeFileSync } from 'node:fs';\nprocess.once('message', (m) => { const start = Date.now(); setTimeout(() => { writeFileSync(m.out, `${start} ${Date.now()}`); process.send({ ok: true, renderMs: 0, rasterMs: 0, fontBytes: 0, rss: 0 }); process.disconnect(); }, 150); });");
    const outs = Array.from({ length: PICTURE_WAITING + 3 }, (_, index) => join(scratch, `q${index}.png`));
    const results = await Promise.all(outs.map((out) => hangulPicture(FIXTURE, "hwpx", out, { entry: slow })));
    const ran = results.flatMap((result, index) => (result.ok ? [readFileSync(outs[index]!, "utf8").split(" ").map(Number) as [number, number]] : []));
    expect(ran).toHaveLength(1 + PICTURE_WAITING);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "busy" }, { ok: false, code: "busy" }]);
    const sorted = [...ran].sort((a, b) => a[0] - b[0]);
    for (let index = 1; index < sorted.length; index += 1) expect(sorted[index]![0]).toBeGreaterThanOrEqual(sorted[index - 1]![1]);
  });

  it("gets only the variables it needs: no token, no vault, no session secret", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: "123:abc", WORKBENCH_VAULT_KEY: "v", ANTHROPIC_API_KEY: "k", NODE_OPTIONS: "--require /x.js", WORKBENCH_RESOURCES_DIR: "/r", WORKBENCH_APP_BIN: "/bin/app" });
    try {
      const keys = job("keys", "import { writeFileSync } from 'node:fs';\nprocess.once('message', (m) => { writeFileSync(m.out, JSON.stringify(process.env)); process.send({ ok: true, renderMs: 0, rasterMs: 0, fontBytes: 0, rss: 0 }); process.disconnect(); });");
      const out = join(scratch, "env.png");
      expect((await hangulPicture(FIXTURE, "hwpx", out, { entry: keys })).ok).toBe(true);
      const seen = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
      expect(Object.keys(seen).sort()).toEqual(Object.keys(pictureEnv()).sort());
      expect(seen).toMatchObject({ WORKBENCH_RESOURCES_DIR: "/r", WORKBENCH_APP_BIN: "/bin/app" });
      for (const name of ["TELEGRAM_BOT_TOKEN", "WORKBENCH_VAULT_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS"]) expect(seen).not.toHaveProperty(name);
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });

  it("exits on its own timer even while its parent is still there", async () => {
    const child = fork(pictureJobEntry()!, ["300"], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], env: pictureEnv() });
    const code = await new Promise<number | null>((done) => { const guard = setTimeout(() => { child.kill(); done(null); }, 10_000); child.once("exit", (exit) => { clearTimeout(guard); done(exit); }); });
    expect(code).toBe(1);
  }, 15_000);

  it("exits when its parent is gone", async () => {
    const parent = job("parent", `import { fork } from 'node:child_process';\nconst child = fork(${JSON.stringify(pictureJobEntry())}, ['60000'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });\nchild.once('spawn', () => { console.log(child.pid); process.exit(0); });`);
    const run = spawn(process.execPath, [parent], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    run.stdout.on("data", (chunk) => { text += String(chunk); });
    await new Promise((done) => run.once("exit", done));
    const pid = Number(text.trim());
    expect(pid).toBeGreaterThan(0);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const until = Date.now() + 10_000;
    while (alive() && Date.now() < until) await new Promise((done) => setTimeout(done, 100));
    const still = alive();
    if (still) process.kill(pid);
    expect(still).toBe(false);
  }, 15_000);
});


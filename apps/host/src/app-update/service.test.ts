import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostUpdateBlocker } from "@workbench/contracts";
import { updateSource } from "./download.ts";
import { resultFile, type InstallPlan } from "./install.ts";
import type { InstallInfo } from "./kind.ts";
import { AppUpdates, installedVersion } from "./service.ts";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const installer = Buffer.alloc(50_000, 3);
const files = new Map<string, Buffer>();
function publish(version: string, opts: { tamperInstaller?: boolean; tamperManifest?: boolean } = {}) {
  const name = `achmage-workbench-${version}-1-x86_64.pkg.tar.zst`;
  const manifest = Buffer.from(JSON.stringify({ version, published: "2026-11-20", notes: "바뀐 점", assets: { pacman: { name, size: installer.length, sha256: createHash("sha256").update(installer).digest("hex") } } }));
  files.set("/update.json", opts.tamperManifest ? Buffer.from(manifest.toString().replace("바뀐 점", "바뀐 점!")) : manifest);
  files.set("/update.json.sig", Buffer.from(sign(null, manifest, privateKey).toString("base64") + "\n"));
  const bytes = Buffer.from(installer); if (opts.tamperInstaller) bytes[100] ^= 1;
  files.set(`/${name}`, bytes);
}
let server: Server, base = "";
beforeAll(async () => {
  server = createServer((req, res) => { const body = files.get(req.url ?? ""); if (!body) { res.writeHead(404); res.end(); return; } res.end(body); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

function make(opts: { blockers?: HostUpdateBlocker[]; installable?: boolean; keys?: string[]; installed?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "wb-upd-")), downloads = join(dataDir, "Downloads");
  let blockers = opts.blockers ?? [];
  const calls = { prepare: 0, cancel: 0, stop: 0, helper: [] as InstallPlan[] };
  const install: InstallInfo = { kind: "user-folder", root: "/home/x/opt/achmage-workbench", target: "/home/x/opt/achmage-workbench", appBin: "/home/x/opt/achmage-workbench/achmage-workbench",
    relaunch: ["/home/x/opt/achmage-workbench/achmage-workbench"], installable: opts.installable ?? true, reason: opts.installable === false ? "앱이 있는 폴더에 쓸 수 없습니다." : null };
  const updates = new AppUpdates({ dataDir, installed: opts.installed ?? "0.5.2", install, keys: opts.keys ?? [spki], source: updateSource({ WORKBENCH_UPDATE_SOURCE: base }), downloadsDir: downloads, pollMs: 20,
    policy: { prepare: () => { calls.prepare++; return { blockers }; }, cancel: () => { calls.cancel++; }, status: () => ({ blockers }) },
    stopForInstall: () => { calls.stop++; }, systemctl: "/usr/bin/systemctl", startHelper: (_file, plan) => { calls.helper.push(plan); }, loginUnit: async () => "kr.achmage.workbench.test.service" });
  return { updates, calls, dataDir, downloads, clear: () => { blockers = []; } };
}
const settle = async (updates: AppUpdates, until: (state: string) => boolean) => { for (let i = 0; i < 200 && !until(updates.status().state); i++) await new Promise(r => setTimeout(r, 10)); return updates.status(); };

describe("check", () => {
  it("the installed version is the release's", () => { expect(installedVersion()).toMatch(/^\d+\.\d+\.\d+/); });
  it("a newer signed version is offered; the same one is 최신", async () => {
    publish("0.5.3");
    const { updates } = make();
    expect((await updates.act("check"))).toMatchObject({ state: "available", available: { version: "0.5.3", notes: "바뀐 점", releaseUrl: "https://github.com/laguna821/Achmage-workbench-CLI/releases/tag/v0.5.3" } });
    expect((await make({ installed: "0.5.3" }).updates.act("check")).state).toBe("latest");
    expect((await make({ installed: "0.5.4" }).updates.act("check"))).toMatchObject({ state: "latest", available: null });
  });
  it("a manifest changed after signing, or signed by another key, is refused in one sentence", async () => {
    publish("0.5.3", { tamperManifest: true });
    expect(await make().updates.act("check")).toMatchObject({ state: "failed", available: null, message: expect.stringContaining("서명이 맞지 않습니다") });
    publish("0.5.3");
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(await make({ keys: [other] }).updates.act("check")).toMatchObject({ state: "failed", available: null });
  });
});

describe("install", () => {
  it("downloads, checks, drains and hands a plan to the helper; the gateway then stops", async () => {
    publish("0.5.3");
    const { updates, calls, dataDir } = make();
    await updates.act("check");
    await updates.act("install");
    const status = await settle(updates, s => s === "installing" || s === "failed");
    expect(status.state).toBe("installing");
    expect(calls.prepare).toBe(1);
    const plan = calls.helper[0]!;
    expect(plan).toMatchObject({ kind: "user-folder", version: "0.5.3", from: "0.5.2", gatewayPid: process.pid, dataDir, restartUnit: "kr.achmage.workbench.test.service" });
    expect(readFileSync(plan.installer).equals(installer)).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    expect(calls.stop).toBe(1);
  });
  it("a tampered installer is not kept and nothing is handed over", async () => {
    publish("0.5.3", { tamperInstaller: true });
    const { updates, calls, dataDir } = make();
    await updates.act("check"); await updates.act("install");
    const status = await settle(updates, s => s === "failed" || s === "installing");
    expect(status).toMatchObject({ state: "failed", message: "내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다." });
    expect(calls.helper).toEqual([]); expect(calls.prepare).toBe(0);
    expect(existsSync(join(dataDir, "updates/0.5.3/achmage-workbench-0.5.3-1-x86_64.pkg.tar.zst"))).toBe(false);
  });
  it("running or unsaved work: says what, waits when asked, and never stops it; 취소 resumes", async () => {
    publish("0.5.3");
    const blocked = make({ blockers: [{ kind: "task", id: "r1", label: "보고서 초안 대화" }, { kind: "office", id: "v1", label: "저장하지 않은 문서 회의록" }] });
    await blocked.updates.act("check"); await blocked.updates.act("install");
    expect(await settle(blocked.updates, s => s === "blocked")).toMatchObject({ state: "blocked", blockers: [{ label: "보고서 초안 대화" }, { label: "저장하지 않은 문서 회의록" }] });
    // Only said: nothing was prepared, new work is still admitted.
    expect(blocked.calls.prepare).toBe(0);
    await blocked.updates.act("cancel");
    expect(blocked.calls.cancel).toBe(0);
    expect(blocked.updates.status().state).toBe("available");
    await blocked.updates.act("install");
    await settle(blocked.updates, s => s === "blocked");
    expect((await blocked.updates.act("wait")).state).toBe("waiting");
    expect(blocked.calls.prepare).toBe(1);
    await new Promise(r => setTimeout(r, 80));
    expect(blocked.calls.helper).toEqual([]);
    blocked.clear();
    expect((await settle(blocked.updates, s => s === "installing")).state).toBe("installing");
    expect(blocked.calls.helper).toHaveLength(1);
  });
  it("a kind that cannot be installed surely: the checked installer goes to the downloads folder with one sentence", async () => {
    publish("0.5.3");
    const { updates, calls, downloads } = make({ installable: false });
    await updates.act("check"); await updates.act("install");
    const status = await settle(updates, s => s === "saved" || s === "failed");
    expect(status.state).toBe("saved");
    expect(status.saved!.path).toBe(join(downloads, "achmage-workbench-0.5.3-1-x86_64.pkg.tar.zst"));
    expect(readFileSync(status.saved!.path).equals(installer)).toBe(true);
    expect(status.saved!.instruction).toMatch(/^앱이 있는 폴더에 쓸 수 없습니다\. /);
    expect(calls.helper).toEqual([]); expect(calls.prepare).toBe(0);
  });
});

describe("result after the restart", () => {
  it("the helper's line is shown once and can be put away", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wb-res-"));
    mkdirSync(join(dataDir, "updates"));
    writeFileSync(resultFile(dataDir), JSON.stringify({ ok: true, version: "0.5.3", from: "0.5.2", kind: "user-folder", message: "0.5.3으로 업데이트했습니다.", at: 1 }));
    for (const left of ["0.5.3/x.pkg.tar.zst", "0.5.4/y.pkg.tar.zst", "helper/update-helper.mjs"]) { mkdirSync(join(dataDir, "updates", left, ".."), { recursive: true }); writeFileSync(join(dataDir, "updates", left), "x"); }
    writeFileSync(join(dataDir, "updates/plan.json"), "{}");
    const info: InstallInfo = { kind: "user-folder", root: "/r", target: "/r", appBin: "/r/a", relaunch: [], installable: true, reason: null };
    const after = new AppUpdates({ dataDir, installed: "0.5.3", install: info, policy: { prepare: () => ({ blockers: [] }), cancel: () => undefined, status: () => ({ blockers: [] }) }, stopForInstall: () => undefined });
    expect(after.status().lastResult).toMatchObject({ ok: true, message: "0.5.3으로 업데이트했습니다." });
    // What the install used is gone; a download of a still newer version stays.
    expect(existsSync(join(dataDir, "updates/0.5.3"))).toBe(false);
    expect(existsSync(join(dataDir, "updates/helper")) || existsSync(join(dataDir, "updates/plan.json"))).toBe(false);
    expect(existsSync(join(dataDir, "updates/0.5.4/y.pkg.tar.zst"))).toBe(true);
    void after.act("dismiss");
    expect(after.status().lastResult).toBeNull();
    expect(new AppUpdates({ dataDir, installed: "0.5.3", install: info, policy: { prepare: () => ({ blockers: [] }), cancel: () => undefined, status: () => ({ blockers: [] }) }, stopForInstall: () => undefined }).status().lastResult).toBeNull();
    // A "success" while the old version still runs is not said as a success.
    writeFileSync(resultFile(dataDir), JSON.stringify({ ok: true, version: "0.5.3", from: "0.5.2", kind: "user-folder", message: "0.5.3으로 업데이트했습니다.", at: 1 }));
    expect(new AppUpdates({ dataDir, installed: "0.5.2", install: info, policy: { prepare: () => ({ blockers: [] }), cancel: () => undefined, status: () => ({ blockers: [] }) }, stopForInstall: () => undefined }).status().lastResult).toMatchObject({ ok: false });
  });
  it("the quiet-check switch is on by default and remembered", async () => {
    const { updates, dataDir } = make();
    expect(updates.status().autoCheck).toBe(true);
    await updates.act("auto-off");
    expect(JSON.parse(readFileSync(join(dataDir, "updates/settings.json"), "utf8")).autoCheck).toBe(false);
  });
});

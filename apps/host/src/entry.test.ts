import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkAtFolder, WorksDirView } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { handleEntry, liveWorkAt, WorksDir } from "./entry.ts";
import { HttpError } from "./errors.ts";
import { createHttpServer } from "./http.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// ① 들어가는 길: the live work of a folder ("같은 폴더 = 같은 프로젝트") and the user-chosen
// location of new project folders, which never moves existing works.

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((run) => run()));

function setup(vault: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "wb-entry-"));
  cleanup.push(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new Store(join(dir, "state.sqlite"));
  const worksDir = new WorksDir(store, join(dir, "data", "works"), () => vault);
  const manager = new SessionManager(store, new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "data", "works"), worksDir: () => worksDir.root(), dataDir: join(dir, "data") });
  return { dir, store, manager, worksDir };
}

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof HttpError ? `${error.status} ${error.code}` : String(error);
  }
  return "ok";
};

describe("the live work of a folder", () => {
  it("compares real paths: links, trailing slashes and .. do not matter", async () => {
    const { dir, manager } = setup();
    const folder = join(dir, "강의");
    mkdirSync(folder);
    symlinkSync(folder, join(dir, "링크"));
    const first = manager.createWork({ title: "처음", cwd: folder });
    expect(liveWorkAt(manager.view, folder)?.id).toBe(first.id);
    expect(liveWorkAt(manager.view, `${folder}/`)?.id).toBe(first.id);
    expect(liveWorkAt(manager.view, join(dir, "링크"))?.id).toBe(first.id);
    expect(liveWorkAt(manager.view, `${dir}/x/../${basename(folder)}`)?.id).toBe(first.id);
    // Several works shared a folder before: the one used last.
    await new Promise((done) => setTimeout(done, 5));
    const later = manager.createWork({ title: "나중", cwd: join(dir, "링크") });
    expect(liveWorkAt(manager.view, folder)?.id).toBe(later.id);
    // A subfolder is another folder; relative or empty paths match nothing.
    mkdirSync(join(folder, "하위"));
    expect(liveWorkAt(manager.view, join(folder, "하위"))).toBeNull();
    expect(liveWorkAt(manager.view, "강의")).toBeNull();
    expect(liveWorkAt(manager.view, "  ")).toBeNull();
    expect(liveWorkAt(manager.view, join(dir, "없는 폴더"))).toBeNull();
  });

  it("skips archived works and works under an archived folder", () => {
    const { dir, manager } = setup();
    const folder = join(dir, "보고서");
    mkdirSync(folder);
    const archived = manager.createWork({ title: "보관", cwd: folder });
    manager.updateWork(archived.id, { archived: true });
    expect(liveWorkAt(manager.view, folder)).toBeNull();
    const shelf = manager.createFolder("지난 학기", null);
    const filed = manager.createWork({ title: "분류됨", cwd: folder, folderId: shelf.id });
    expect(liveWorkAt(manager.view, folder)?.id).toBe(filed.id);
    manager.updateFolder(shelf.id, { archived: true });
    expect(liveWorkAt(manager.view, folder)).toBeNull();
  });
});

describe("새 프로젝트 폴더 위치", () => {
  it("starts at the gateway's own folder, made when first needed", () => {
    const { dir, worksDir, manager } = setup();
    expect(worksDir.view()).toEqual({ path: join(dir, "data", "works"), defaultPath: join(dir, "data", "works"), custom: false, problem: null });
    const work = manager.createWork({ title: "폴더 없이" });
    expect(work.cwdManaged).toBe(true);
    expect(work.cwd.startsWith(join(dir, "data", "works") + "/")).toBe(true);
    expect(existsSync(work.cwd)).toBe(true);
  });

  it("puts new projects under the chosen folder; existing works stay where they are", () => {
    const { dir, worksDir, manager } = setup();
    const before = manager.createWork({ title: "전에 만든 일" });
    const chosen = join(dir, "프로젝트");
    mkdirSync(chosen);
    expect(worksDir.set(chosen)).toEqual({ path: chosen, defaultPath: join(dir, "data", "works"), custom: true, problem: null });
    const after = manager.createWork({ title: "새 일" });
    expect(after.cwdManaged).toBe(true);
    expect(after.cwd).toBe(join(chosen, after.id));
    expect(existsSync(after.cwd)).toBe(true);
    // The older one is where it was, and a work with its own folder is unaffected.
    expect(manager.view.works.get(before.id)!.cwd).toBe(before.cwd);
    expect(existsSync(before.cwd)).toBe(true);
    const own = join(dir, "내 폴더");
    expect(manager.createWork({ title: "폴더 있음", cwd: own }).cwd).toBe(own);
    // Back to the default: the next one goes there again.
    expect(worksDir.reset().custom).toBe(false);
    expect(manager.createWork({ title: "다시 기본" }).cwd.startsWith(join(dir, "data", "works") + "/")).toBe(true);
    expect(manager.view.works.get(after.id)!.cwd).toBe(join(chosen, after.id));
  });

  it("takes only an absolute folder that takes files, never inside the vault", () => {
    const vault = mkdtempSync(join(tmpdir(), "wb-entry-vault-"));
    cleanup.push(() => rmSync(vault, { recursive: true, force: true }));
    const { dir, worksDir } = setup(vault);
    expect(code(() => worksDir.set("상대/경로"))).toBe("400 invalid_path");
    expect(code(() => worksDir.set(""))).toBe("400 invalid_path");
    expect(code(() => worksDir.set(join(vault, "프로젝트")))).toBe("400 inside_vault");
    expect(code(() => worksDir.set(vault))).toBe("400 inside_vault");
    expect(code(() => worksDir.set(join(dir, "없음", "더 없음")))).toBe("400 missing_folder");
    writeFileSync(join(dir, "파일"), "x");
    expect(code(() => worksDir.set(join(dir, "파일")))).toBe("400 not_folder");
    const locked = join(dir, "잠김");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    cleanup.unshift(() => chmodSync(locked, 0o755));
    if (process.getuid?.() !== 0) expect(code(() => worksDir.set(locked))).toBe("400 not_writable");
    expect(worksDir.view().custom).toBe(false);
    // Only the last part missing: made. `~` is the home folder.
    const made = join(dir, "새로 만들 폴더");
    expect(worksDir.set(`${made}/`).path).toBe(made);
    expect(existsSync(made)).toBe(true);
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      expect(worksDir.set("~/새로 만들 폴더").path).toBe(made);
    } finally {
      process.env.HOME = home;
    }
    // The default itself is the default again, not a custom choice.
    expect(worksDir.set(join(dir, "data", "works")).custom).toBe(false);
  });

  it("reports a chosen folder that went away instead of quietly using another", () => {
    const { dir, worksDir, manager } = setup();
    const chosen = join(dir, "외장 디스크");
    mkdirSync(chosen);
    worksDir.set(chosen);
    rmSync(chosen, { recursive: true });
    expect(worksDir.view().problem).toBe("폴더가 없습니다");
    expect(code(() => manager.createWork({ title: "어디로" }))).toBe("409 works_dir_unusable");
    expect([...manager.view.works.values()]).toHaveLength(0);
  });
});

describe("/api/entry routes", () => {
  it("answers the folder's work and keeps the location", async () => {
    const { dir, manager, worksDir } = setup();
    const token = "t";
    const server = createHttpServer(manager, new EventBus(), { token, webDir: null, entry: (req, res, url) => handleEntry({ view: () => manager.view, worksDir }, req, res, url) });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanup.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async <T>(method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as T };
    };
    const folder = join(dir, "같은 폴더");
    mkdirSync(folder);
    const work = manager.createWork({ title: "같은 폴더 일", cwd: folder });
    expect((await call<WorkAtFolder>("GET", `/api/entry/work?path=${encodeURIComponent(`${folder}/`)}`)).body.work?.id).toBe(work.id);
    expect((await call<WorkAtFolder>("GET", `/api/entry/work?path=${encodeURIComponent(join(dir, "다른 폴더"))}`)).body.work).toBeNull();
    const chosen = join(dir, "고른 곳");
    mkdirSync(chosen);
    expect((await call<WorksDirView>("PUT", "/api/entry/works-dir", { path: chosen })).body.path).toBe(chosen);
    expect((await call<WorksDirView>("GET", "/api/entry/works-dir")).body.custom).toBe(true);
    const refused = await call<{ code: string }>("PUT", "/api/entry/works-dir", { path: "상대" });
    expect([refused.status, refused.body.code]).toEqual([400, "invalid_path"]);
    expect((await call<WorksDirView>("DELETE", "/api/entry/works-dir")).body.custom).toBe(false);
    expect((await fetch(`${base}/api/entry/works-dir`)).status).toBe(401);
  });
});

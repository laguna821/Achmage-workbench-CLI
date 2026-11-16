import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { symlinkSync } from "node:fs";
import { DITTO, HDIUTIL, nsisArgs, relaunchEnv, resultFile, runInstall, takeLock, type HelperDeps, type InstallPlan } from "./install.ts";
import { extractPrefix } from "./tar.ts";

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A pacman-shaped package made at test time with the system tar (pax) and Node's zstd. */
export function makePackage(dir: string, version: string, extra: (root: string) => void = () => undefined) {
  const src = join(dir, `pkg-src-${version}`), lib = join(src, "usr/lib/achmage-workbench");
  mkdirSync(join(lib, "host"), { recursive: true }); mkdirSync(join(lib, "web/assets"), { recursive: true }); mkdirSync(join(src, "usr/bin"), { recursive: true });
  writeFileSync(join(lib, "achmage-workbench"), `#!/bin/sh\necho ${version}\n`); chmodSync(join(lib, "achmage-workbench"), 0o755);
  writeFileSync(join(lib, "host/host.mjs"), `export const version = "${version}";\n`);
  writeFileSync(join(lib, "host/workbench-service.mjs"), "// service\n");
  writeFileSync(join(lib, "web/index.html"), `<title>${version}</title>`);
  writeFileSync(join(lib, "web/assets/" + "a".repeat(120) + ".js"), "long name\n");
  writeFileSync(join(src, "usr/bin/achmage-workbench"), "#!/bin/sh\n");
  writeFileSync(join(src, ".PKGINFO"), `pkgver = ${version}-1\n`);
  extra(src);
  const tar = join(dir, `pkg-${version}.tar`), out = join(dir, `achmage-workbench-${version}-1-x86_64.pkg.tar.zst`);
  execFileSync("tar", ["--format=pax", "-C", src, "-cf", tar, ".PKGINFO", "usr"]);
  writeFileSync(out, zstdCompressSync(readFileSync(tar)));
  return out;
}
function oldFolder(dir: string) {
  const root = join(dir, "opt/achmage-workbench");
  mkdirSync(join(root, "host"), { recursive: true }); mkdirSync(join(root, "web"), { recursive: true }); mkdirSync(join(root, "node"), { recursive: true });
  writeFileSync(join(root, "achmage-workbench"), "#!/bin/sh\necho 0.5.2\n"); chmodSync(join(root, "achmage-workbench"), 0o755);
  writeFileSync(join(root, "host/host.mjs"), "old"); writeFileSync(join(root, "web/index.html"), "old");
  writeFileSync(join(root, "node/node"), "node binary"); writeFileSync(join(root, "WORKBENCH-INSTALL.json"), "{}");
  return root;
}
function fakeDeps(overrides: Partial<HelperDeps> = {}) {
  const ran: string[][] = [], launched: string[][] = [], lines: string[] = [];
  const deps: HelperDeps = { platform: "linux", waitMs: 300, run: async (command, args) => { ran.push([command, ...args]); return 0; }, launch: (command, args) => { launched.push([command, ...args]); },
    alive: () => false, appRunning: async () => false, sleep: async () => undefined, log: line => { lines.push(line); }, ...overrides };
  return { deps, ran, launched, lines };
}
function planFor(dir: string, installer: string, kind: InstallPlan["kind"], target: string, extra: Partial<InstallPlan> = {}): InstallPlan {
  const data = join(dir, "data"); mkdirSync(data, { recursive: true });
  return { kind, version: "0.5.3", from: "0.5.2", installer, sha256: sha(installer), size: statSync(installer).size, target, appBin: join(target, "achmage-workbench"),
    relaunch: [join(target, "achmage-workbench")], gatewayPid: 999_999, dataDir: data, restartUnit: null, ...extra };
}
const tree = (root: string) => existsSync(root) ? execFileSync("find", [root, "-printf", "%P %s\n"], { encoding: "utf8" }).split("\n").sort().join("\n") : "";

describe("Linux user folder", () => {
  it("unpacks the package beside the folder, swaps it in by rename, keeps the old one as the ONE backup, restarts the login unit and the app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-uf-")), root = oldFolder(dir), before = tree(root);
    const pkg = makePackage(dir, "0.5.3");
    const { deps, ran, launched } = fakeDeps();
    const result = await runInstall(planFor(dir, pkg, "user-folder", root, { restartUnit: "kr.achmage.workbench.test.service", systemctl: "/usr/bin/systemctl" }), deps);
    expect(result).toMatchObject({ ok: true, message: "0.5.3으로 업데이트했습니다." });
    expect(readFileSync(join(root, "host/host.mjs"), "utf8")).toContain("0.5.3");
    expect(readFileSync(join(root, "web/index.html"), "utf8")).toContain("0.5.3");
    expect(statSync(join(root, "achmage-workbench")).mode & 0o111).toBeTruthy();
    expect(existsSync(join(root, "web/assets/" + "a".repeat(120) + ".js"))).toBe(true);
    // The person's own files stay; nothing outside the package's folder comes in.
    expect(readFileSync(join(root, "node/node"), "utf8")).toBe("node binary");
    expect(existsSync(join(root, "WORKBENCH-INSTALL.json"))).toBe(true);
    expect(existsSync(join(root, ".PKGINFO")) || existsSync(join(root, "usr"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "install-kind.json"), "utf8"))).toEqual({ kind: "user-folder" });
    expect(tree(`${root}.previous`)).toBe(before);
    expect(readdirSync(join(dir, "opt")).sort()).toEqual(["achmage-workbench", "achmage-workbench.previous"]);
    expect(ran).toEqual([["/usr/bin/systemctl", "--user", "restart", "kr.achmage.workbench.test.service"]]);
    expect(launched).toEqual([[join(root, "achmage-workbench")]]);
    expect(JSON.parse(readFileSync(resultFile(join(dir, "data")), "utf8"))).toMatchObject({ ok: true, version: "0.5.3", from: "0.5.2" });
    // A second update keeps ONE backup: the folder that was there just before.
    const after = tree(root);
    const pkg4 = makePackage(dir, "0.5.4");
    expect((await runInstall({ ...planFor(dir, pkg4, "user-folder", root), version: "0.5.4", from: "0.5.3" }, fakeDeps().deps)).ok).toBe(true);
    expect(tree(`${root}.previous`)).toBe(after);
    expect(readdirSync(join(dir, "opt")).sort()).toEqual(["achmage-workbench", "achmage-workbench.previous"]);
  });
  it("a tampered installer changes nothing and starts the app that was there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-uf-")), root = oldFolder(dir), before = tree(root);
    const pkg = makePackage(dir, "0.5.3"), plan = planFor(dir, pkg, "user-folder", root);
    const bytes = readFileSync(pkg); bytes[bytes.length - 10] ^= 0xff; writeFileSync(pkg, bytes);
    const { deps, launched } = fakeDeps();
    const result = await runInstall(plan, deps);
    expect(result).toMatchObject({ ok: false, message: "내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다." });
    expect(tree(root)).toBe(before);
    expect(readdirSync(join(dir, "opt"))).toEqual(["achmage-workbench"]);
    expect(launched).toEqual([[join(root, "achmage-workbench")]]);
  });
  it("a package with an entry that leaves its folder, or without the app's files, changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-uf-")), root = oldFolder(dir), before = tree(root);
    const evil = makePackage(dir, "0.5.3", src => { mkdirSync(join(src, "usr/lib/achmage-workbench/x"), { recursive: true }); execFileSync("ln", ["-s", "/etc/passwd", join(src, "usr/lib/achmage-workbench/x/link")]); });
    expect(await runInstall(planFor(dir, evil, "user-folder", root), fakeDeps().deps)).toMatchObject({ ok: false, message: expect.stringContaining("온전하지 않아") });
    expect(tree(root)).toBe(before);
    const empty = makePackage(join(dir), "0.5.5", src => { execFileSync("rm", ["-rf", join(src, "usr/lib/achmage-workbench/web")]); });
    expect(await runInstall(planFor(dir, empty, "user-folder", root), fakeDeps().deps)).toMatchObject({ ok: false });
    expect(tree(root)).toBe(before);
    expect(readdirSync(join(dir, "opt"))).toEqual(["achmage-workbench"]);
  });
  it("an app that does not close is not installed over", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-uf-")), root = oldFolder(dir), before = tree(root);
    const { deps } = fakeDeps({ appRunning: async () => true });
    expect(await runInstall(planFor(dir, makePackage(dir, "0.5.3"), "user-folder", root), deps)).toMatchObject({ ok: false, message: expect.stringContaining("앱이 닫히지 않아") });
    expect(tree(root)).toBe(before);
    const gateway = fakeDeps({ alive: () => true });
    expect(await runInstall(planFor(dir, makePackage(dir, "0.5.3"), "user-folder", root), gateway.deps)).toMatchObject({ ok: false });
  });
});

describe("other kinds (commands injected; nothing is run for real)", () => {
  const installerIn = (dir: string, name: string) => { const file = join(dir, name); writeFileSync(file, "installer bytes"); return file; };
  it("AppImage: the file is replaced where it is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-ai-")), image = join(dir, "Apps/Achmage.AppImage");
    mkdirSync(join(dir, "Apps")); writeFileSync(image, "old image");
    const installer = installerIn(dir, "Achmage.Workbench_0.5.3_amd64.AppImage");
    const { deps, launched } = fakeDeps();
    expect((await runInstall(planFor(dir, installer, "appimage", image, { appBin: "/tmp/.mount_x/usr/bin/achmage-workbench", relaunch: [image] }), deps)).ok).toBe(true);
    expect(readFileSync(image, "utf8")).toBe("installer bytes");
    expect(statSync(image).mode & 0o111).toBeTruthy();
    expect(readdirSync(join(dir, "Apps"))).toEqual(["Achmage.AppImage"]);
    expect(launched).toEqual([[image]]);
  });
  it("deb, pacman and MSI are never run from here (they take the saved-installer fallback; review M1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-pk-"));
    for (const [kind, name] of [["deb", "Achmage.Workbench_0.5.3_amd64.deb"], ["pacman", "achmage-workbench-0.5.3-1-x86_64.pkg.tar.zst"], ["msi", "Achmage.Workbench_0.5.3_x64_ko-KR.msi"]] as const) {
      const asked = fakeDeps();
      const plan = { ...planFor(dir, installerIn(dir, name), "nsis", "/usr/lib/achmage-workbench"), kind } as unknown as InstallPlan;
      expect((await runInstall(plan, asked.deps)).ok, kind).toBe(false);
      expect(asked.ran, kind).toEqual([]);
    }
  });
  it("Windows: NSIS silently through its own update path, as the person", async () => {
    expect(nsisArgs()).toEqual(["/S", "/UPDATE"]);
    const dir = mkdtempSync(join(tmpdir(), "wb-win-")), exe = installerIn(dir, "Achmage.Workbench_0.5.3_x64-setup.exe");
    const nsis = fakeDeps();
    expect((await runInstall(planFor(dir, exe, "nsis", "C:\\Users\\a\\AppData\\Local\\Achmage Workbench", { relaunch: ["C:\\app.exe"] }), nsis.deps)).ok).toBe(true);
    expect(nsis.ran).toEqual([[exe, "/S", "/UPDATE"]]);
    const failed = fakeDeps({ run: async () => 2 });
    expect(await runInstall(planFor(dir, exe, "nsis", "C:\\x"), failed.deps)).toMatchObject({ ok: false, message: expect.stringContaining("지금 있던 앱은 그대로") });
  });
  it("macOS: mount without showing, copy beside, swap, unmount; a failed copy leaves the old app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-mac-")), app = join(dir, "Applications/Achmage Workbench.app");
    mkdirSync(join(app, "Contents/MacOS"), { recursive: true }); writeFileSync(join(app, "Contents/MacOS/achmage-workbench"), "old");
    const image = installerIn(dir, "Achmage.Workbench_0.5.3_aarch64.dmg");
    const stand = (copyCode: number) => { const made: ReturnType<typeof fakeDeps> = fakeDeps({ run: async (command, args) => {
      made.ran.push([command, ...args]);
      if (command === HDIUTIL && args[0] === "attach") { const mount = args[args.indexOf("-mountpoint") + 1]!; mkdirSync(join(mount, "Achmage Workbench.app/Contents/MacOS"), { recursive: true }); writeFileSync(join(mount, "Achmage Workbench.app/Contents/MacOS/achmage-workbench"), "new"); }
      if (command === DITTO) { if (copyCode) return copyCode; cpSync(args[0]!, args[1]!, { recursive: true }); }
      return 0;
    } }); return made; };
    const failed = stand(1);
    expect((await runInstall(planFor(dir, image, "dmg", app, { relaunch: ["open", app] }), failed.deps)).ok).toBe(false);
    expect(readFileSync(join(app, "Contents/MacOS/achmage-workbench"), "utf8")).toBe("old");
    const ok = stand(0);
    expect((await runInstall(planFor(dir, image, "dmg", app, { relaunch: ["open", app] }), ok.deps)).ok).toBe(true);
    expect(readFileSync(join(app, "Contents/MacOS/achmage-workbench"), "utf8")).toBe("new");
    expect(ok.ran.map(call => call[0])).toEqual(["/usr/bin/hdiutil", "/usr/bin/ditto", "/usr/bin/hdiutil"]);
    expect(ok.ran[2]!.slice(0, 2)).toEqual(["/usr/bin/hdiutil", "detach"]);
    expect(ok.ran[0]).toContain("-nobrowse");
    expect(readdirSync(join(dir, "Applications"))).toEqual(["Achmage Workbench.app"]);
    expect(ok.launched).toEqual([["open", app]]);
  });
});

describe("the unpack never writes through a link (review L1)", () => {
  const pack = (dir: string, build: (lib: string) => void) => {
    const src = join(dir, "src"), lib = join(src, "usr/lib/achmage-workbench");
    mkdirSync(lib, { recursive: true }); build(lib);
    const tar = join(dir, "p.tar"), out = join(dir, "p.tar.zst");
    execFileSync("tar", ["--format=pax", "-C", src, "-cf", tar, "usr"]);
    writeFileSync(out, zstdCompressSync(readFileSync(tar)));
    return out;
  };
  it("refuses the a→., a/b→.., b/file chain and writes nothing outside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-tar-")), box = join(dir, "box"); mkdirSync(box);
    // The probe's chain built by hand: tar cannot store a/b while a is a link, so a is a folder here and the
    // link a → . is a second archive member added with --transform.
    const src = join(dir, "src"), lib = join(src, "usr/lib/achmage-workbench");
    mkdirSync(join(lib, "x"), { recursive: true }); mkdirSync(join(lib, "b"));
    symlinkSync(".", join(lib, "x/a")); symlinkSync("..", join(lib, "x/b")); writeFileSync(join(lib, "b/escaped.txt"), "out");
    const tar = join(dir, "p.tar");
    execFileSync("tar", ["--format=pax", "-C", src, "-cf", tar, "--transform", "s,^usr/lib/achmage-workbench/x/a$,usr/lib/achmage-workbench/a,;s,^usr/lib/achmage-workbench/x/b$,usr/lib/achmage-workbench/a/b,",
      "usr/lib/achmage-workbench/x/a", "usr/lib/achmage-workbench/x/b", "usr/lib/achmage-workbench/b/escaped.txt"]);
    const archive = join(dir, "p.tar.zst"); writeFileSync(archive, zstdCompressSync(readFileSync(tar)));
    await expect(extractPrefix(archive, "usr/lib/achmage-workbench/", join(box, "app.update-new"))).rejects.toThrow();
    expect(readdirSync(box)).toEqual(["app.update-new"]);
    expect(existsSync(join(dir, "escaped.txt")) || existsSync(join(box, "escaped.txt"))).toBe(false);
  });
  it("makes a link that stays inside, and never places an entry through an existing link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-tar-"));
    const archive = pack(dir, lib => { mkdirSync(join(lib, "bin")); writeFileSync(join(lib, "bin/tool.js"), "x"); mkdirSync(join(lib, ".bin")); symlinkSync("../bin/tool.js", join(lib, ".bin/tool")); });
    const dest = join(dir, "dest");
    await extractPrefix(archive, "usr/lib/achmage-workbench/", dest);
    expect(readFileSync(join(dest, ".bin/tool"), "utf8")).toBe("x");
    // A destination whose folder is already a link to elsewhere is refused, and nothing lands there.
    const outside = join(dir, "outside"), trap = join(dir, "trap"); mkdirSync(outside); mkdirSync(trap);
    symlinkSync(outside, join(trap, "bin"));
    await expect(extractPrefix(archive, "usr/lib/achmage-workbench/", trap)).rejects.toThrow(/link or file is in the way/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("a swap that cannot finish leaves the app (review L3)", () => {
  it("an injected failure between the two renames puts the old folder back before failing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-l3-")), root = oldFolder(dir), before = tree(root);
    const { deps, launched } = fakeDeps({ beforePlace: () => { throw Object.assign(new Error("injected"), { code: "EIO" }); } });
    expect((await runInstall(planFor(dir, makePackage(dir, "0.5.3"), "user-folder", root), deps)).ok).toBe(false);
    expect(tree(root)).toBe(before);
    expect(readdirSync(join(dir, "opt"))).toEqual(["achmage-workbench"]);
    expect(launched).toEqual([[join(root, "achmage-workbench")]]);
  });
  it("a helper killed half-way: the next helper puts the backup back first (user folder and AppImage)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-l3-")), root = oldFolder(dir), before = tree(root);
    execFileSync("mv", [root, `${root}.previous`]);
    const pkg = makePackage(dir, "0.5.3"), plan = planFor(dir, pkg, "user-folder", root);
    writeFileSync(pkg, "changed");
    const { deps, lines } = fakeDeps();
    expect((await runInstall(plan, deps)).ok).toBe(false);
    expect(tree(root)).toBe(before);
    expect(lines.some(line => line.startsWith("recovered"))).toBe(true);
    const image = join(dir, "A.AppImage"); writeFileSync(`${image}.previous`, "old image");
    const installer = join(dir, "Achmage.Workbench_0.5.3_amd64.AppImage"); writeFileSync(installer, "new image");
    expect((await runInstall(planFor(dir, installer, "appimage", image, { relaunch: [image] }), fakeDeps().deps)).ok).toBe(true);
    expect(readFileSync(image, "utf8")).toBe("new image");
  });
});

describe("helper housekeeping", () => {
  it("one helper at a time; the app is started again without the gateway's launch variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-lock-"));
    const release = takeLock(dir);
    expect(release).toBeTypeOf("function");
    expect(takeLock(dir)).toBeNull();
    release!();
    expect(takeLock(dir)).toBeTypeOf("function");
    expect(relaunchEnv({ PATH: "/bin", WORKBENCH_DATA_DIR: "/d", WORKBENCH_TOKEN: "t", WORKBENCH_HOST_MODE: "service", NODE_OPTIONS: "--require x", LD_PRELOAD: "x", APPIMAGE: "/a", HOME: "/h" }))
      .toEqual({ PATH: "/bin", WORKBENCH_DATA_DIR: "/d", HOME: "/h" });
  });
});

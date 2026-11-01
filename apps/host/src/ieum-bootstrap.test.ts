import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { IeumDesktop, versionAtLeast, type DesktopRelease } from "./ieum-desktop.ts";
import { registerIeumDesktop, type DesktopRegistration } from "./ieum-registration.ts";
import type { IeumInstall } from "./ieumoffice.ts";

const run = promisify(execFile), roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wb-ieum-setup-")); roots.push(root);
  const folder = join(root, "standalone"), app = join(folder, "ieumoffice"), script = join(folder, "resources/cli/genoffice.cjs");
  mkdirSync(dirname(script), { recursive: true }); writeFileSync(app, "app"); writeFileSync(script, "cli");
  return { root, app, install: { app, script, launcher: script, bundled: false } as IeumInstall };
}
const release: DesktopRelease = { tag_name: "v0.12.10", assets: [] };

class Setup extends IeumDesktop {
  calls = { release: 0, install: 0, register: 0 };
  existing: IeumInstall | null = null;
  current = "0.12.10";
  offline = false;
  fixture: ReturnType<typeof fixture>;
  constructor(f: ReturnType<typeof fixture>) { super(join(f.root, "workbench"), () => {}); this.fixture = f; }
  override find() { return this.existing && existsSync(this.existing.app!) ? this.existing : null; }
  protected override async version() { return this.current; }
  protected override async latestRelease() { this.calls.release += 1; if (this.offline) throw new Error("network unavailable"); return release; }
  protected override async performInstall() { this.calls.install += 1; this.existing = this.fixture.install; return this.existing; }
  protected override async register(app: string): Promise<DesktopRegistration> {
    this.calls.register += 1;
    const entry = join(this.fixture.root, "IeumOffice.desktop"); writeFileSync(entry, app);
    return { platform: "linux", entry, executable: app };
  }
}

it("automatically installs, registers and links once even with overlapping setup requests", async () => {
  const f = fixture(), setup = new Setup(f);
  const first = setup.bootstrap(), second = setup.bootstrap();
  expect(first).toBe(second); expect(setup.status().busy).toBe(true);
  await first;
  expect(setup.calls).toEqual({ release: 1, install: 1, register: 1 });
  expect(setup.status()).toMatchObject({ setup: "ready", available: true, registered: true, busy: false, version: "0.12.10", path: f.app });
  const next = new Setup(f); next.existing = f.install;
  await next.bootstrap();
  expect(next.calls).toEqual({ release: 0, install: 0, register: 0 });
  expect(next.status().registered).toBe(true);
});

it("reuses the current/newer app and upgrades an older app without touching user files", async () => {
  const f = fixture(), setup = new Setup(f); setup.existing = f.install; setup.current = "0.12.11";
  const user = join(f.root, "user.hwpx"); writeFileSync(user, "protected");
  await setup.bootstrap(); expect(setup.calls.install).toBe(0);
  setup.current = "0.12.9"; await setup.bootstrap(true);
  expect(setup.calls.install).toBe(1);
  expect(readFileSync(user, "utf8")).toBe("protected");
  expect(versionAtLeast("0.12.10", "0.12.9")).toBe(true);
  expect(versionAtLeast("0.12.10-beta.1", "0.12.10")).toBe(false);
});

it("persists an incomplete offline setup and retries after connectivity changes", async () => {
  const f = fixture(), setup = new Setup(f); setup.offline = true;
  await expect(setup.bootstrap()).rejects.toThrow("network unavailable");
  expect(setup.status()).toMatchObject({ setup: "error", available: false, busy: false, registered: false });
  expect(JSON.parse(readFileSync(join(f.root, "workbench/ieum-desktop.json"), "utf8")).setupError).toContain("network unavailable");
  const next = new Setup(f); await next.bootstrap();
  expect(next.status()).toMatchObject({ setup: "ready", registered: true });
  expect(JSON.parse(readFileSync(join(f.root, "workbench/ieum-desktop.json"), "utf8")).setupError).toBeUndefined();
});

it("a missing OS entry is repaired instead of reporting a stale completed setup", async () => {
  const f = fixture(), setup = new Setup(f); await setup.bootstrap();
  rmSync(setup.status().registration!);
  const next = new Setup(f); next.existing = f.install;
  await next.bootstrap();
  expect(next.calls.install).toBe(0); expect(next.calls.register).toBe(1);
  expect(next.status().registered).toBe(true);
});

it.skipIf(process.platform === "win32")("a version symlink stays registered after restarting with the real app path", async () => {
  const f = fixture(), current = join(f.root, "current"); symlinkSync(dirname(f.app), current);
  const setup = new Setup(f); setup.existing = { ...f.install, app: join(current, "ieumoffice") };
  await setup.bootstrap();
  const saved = JSON.parse(readFileSync(join(f.root, "workbench/ieum-desktop.json"), "utf8"));
  expect(saved.path).toBe(f.app);
  const next = new IeumDesktop(join(f.root, "workbench"), () => {});
  expect(next.status()).toMatchObject({ setup: "ready", available: true, registered: true, path: f.app });
  await next.bootstrap();
});

it.skipIf(process.platform !== "linux")("Linux app-menu launch is independent of Workbench and preserves quoted paths/arguments", async () => {
  const f = fixture();
  const externalData = join(f.root, '이음 앱 $금액 `값` "표" 100%'), app = join(externalData, "installed", "ieumoffice");
  mkdirSync(dirname(app), { recursive: true });
  const output = join(f.root, "launched.json");
  writeFileSync(app, `#!/usr/bin/python3\nimport json,sys\nfrom pathlib import Path\nPath(${JSON.stringify(output)}).write_text(json.dumps(sys.argv))\n`, { mode: 0o755 });
  const registration = await registerIeumDesktop(app, { home: f.root, env: { XDG_DATA_HOME: externalData } });
  expect(registration.entry).toBe(join(externalData, "applications/ieumoffice.desktop"));
  const input = join(f.root, "문서 공백.docx"); writeFileSync(input, "original");
  // Launch through the OS desktop-entry parser, not by directly calling the wrapper.
  await run("gio", ["launch", registration.entry, input], { timeout: 10_000 });
  await expect.poll(() => existsSync(output), { timeout: 3_000 }).toBe(true);
  const args = JSON.parse(readFileSync(output, "utf8")) as string[];
  expect(args[0]).toBe(app);
  expect(args.some(arg => arg === input || arg === pathToFileURL(input).href)).toBe(true);
  expect(readFileSync(input, "utf8")).toBe("original");
  const original = readFileSync(registration.entry, "utf8");
  await registerIeumDesktop(app, { home: f.root, env: { XDG_DATA_HOME: externalData } });
  expect(readFileSync(registration.entry, "utf8")).toBe(original);
});

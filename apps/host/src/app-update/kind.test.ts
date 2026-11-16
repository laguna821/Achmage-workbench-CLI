import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectInstall } from "./kind.ts";

function layout(root: string, kind: string | null, bin = "achmage-workbench") {
  mkdirSync(join(root, "host"), { recursive: true }); mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(join(root, "host/host.mjs"), ""); writeFileSync(join(root, "host/workbench-service.mjs"), ""); writeFileSync(join(root, "web/index.html"), "");
  writeFileSync(join(root, bin), ""); chmodSync(join(root, bin), 0o755);
  if (kind) writeFileSync(join(root, "install-kind.json"), JSON.stringify({ kind }));
  return join(root, "host/host.mjs");
}

describe("install kind", () => {
  it("a person's own folder (the package payload, marker or none) is the user-folder kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-kind-"));
    for (const marker of [null, "pacman", "user-folder"]) {
      const root = join(dir, `opt-${marker}`, "achmage-workbench");
      const info = detectInstall({ hostEntry: layout(root, marker), platform: "linux" });
      expect(info).toMatchObject({ kind: "user-folder", installable: true, target: root, relaunch: [join(root, "achmage-workbench")] });
    }
  });
  it("deb and pacman markers count only where the package manager puts them, and need pkexec", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-kind-"));
    expect(detectInstall({ hostEntry: layout(join(dir, "x"), "deb"), platform: "linux" }).kind).toBe("user-folder");
    // The real places are under /usr: the marker is read from there, so only the rule is checked here.
    expect(detectInstall({ hostEntry: "/usr/lib/achmage-workbench/host/host.mjs", platform: "linux" }).kind).toBe("none");
  });
  it("an AppImage needs the original file's place; without it, the fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-kind-")), mount = join(dir, "mount/usr/lib/Achmage Workbench");
    const entry = layout(mount, "appimage");
    const image = join(dir, "Achmage.AppImage"); writeFileSync(image, "");
    expect(detectInstall({ hostEntry: entry, platform: "linux", appImage: image })).toMatchObject({ kind: "appimage", installable: true, target: image, relaunch: [image] });
    expect(detectInstall({ hostEntry: entry, platform: "linux" })).toMatchObject({ kind: "appimage", installable: false });
  });
  it("Windows: NSIS when its uninstaller is beside the app, else MSI by the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-kind-")), root = join(dir, "Achmage Workbench");
    const entry = layout(root, "windows", "achmage-workbench.exe");
    // MSI is recognised but not installed in place (it runs elevated): the checked installer is saved instead.
    expect(detectInstall({ hostEntry: entry, platform: "win32" })).toMatchObject({ kind: "msi", installable: false });
    writeFileSync(join(root, "uninstall.exe"), "");
    expect(detectInstall({ hostEntry: entry, platform: "win32" }).kind).toBe("nsis");
  });
  it("macOS: the dmg marker inside an .app bundle the person can write", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-kind-")), bundle = join(dir, "Applications/Achmage Workbench.app");
    const entry = layout(join(bundle, "Contents/Resources"), "dmg");
    expect(detectInstall({ hostEntry: entry, platform: "darwin" })).toMatchObject({ kind: "dmg", installable: true, target: bundle, relaunch: ["open", bundle] });
    chmodSync(join(dir, "Applications"), 0o555);
    try { expect(detectInstall({ hostEntry: entry, platform: "darwin" })).toMatchObject({ kind: "dmg", installable: false }); } finally { chmodSync(join(dir, "Applications"), 0o755); }
  });
  it("a source checkout or an unknown layout has no install key", () => {
    expect(detectInstall({ hostEntry: "/src/apps/host/src/main.ts", platform: "linux" }).kind).toBe("none");
    const dir = mkdtempSync(join(tmpdir(), "wb-kind-"));
    mkdirSync(join(dir, "host")); writeFileSync(join(dir, "host/host.mjs"), "");
    expect(detectInstall({ hostEntry: join(dir, "host/host.mjs"), platform: "linux" }).kind).toBe("none");
  });
});

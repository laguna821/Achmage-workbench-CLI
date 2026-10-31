import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import manifest from "../../../packaging/windows-legacy-v0.2.2.json" with { type: "json" };
import { cleanupLegacyResources, obsoleteResourcePath, type LegacyResource } from "./legacy-resources.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wb-legacy-cleanup-")); roots.push(root);
  writeFileSync(join(root, "achmage-workbench.exe"), "new app");
  return root;
}
function file(root: string, path: string, text: string): LegacyResource {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
  return { path, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") };
}

it("removes only pinned unchanged files and empty directories, and is repeatable", () => {
  const root = fixture();
  const files = [file(root, "hop/bin/old.exe", "old hop"), file(root, "ieumoffice/resources/modules/old.js", "old editor")];
  file(root, "ieumoffice/resources/cli/genoffice.cjs", "current engine");
  const result = cleanupLegacyResources(root, files);
  expect(result.removed).toEqual(files.map(f => f.path));
  expect(result.removedBytes).toBe(files.reduce((sum, f) => sum + f.bytes, 0));
  expect(result.failed).toEqual([]);
  expect(existsSync(join(root, "hop"))).toBe(false);
  expect(existsSync(join(root, "ieumoffice/resources/modules"))).toBe(false);
  expect(readFileSync(join(root, "ieumoffice/resources/cli/genoffice.cjs"), "utf8")).toBe("current engine");
  expect(cleanupLegacyResources(root, files).removed).toEqual([]);
});

it("preserves added files and same-size user modifications inside former bundle folders", () => {
  const root = fixture();
  const original = file(root, "kordoc/SKILL.md", "old text");
  writeFileSync(join(root, original.path), "new text");
  file(root, "kordoc/my-template.hwpx", "personal template");
  const retired = file(root, "kordoc/lib/old.js", "retired");
  const result = cleanupLegacyResources(root, [original, retired]);
  expect(result.preserved).toEqual([original.path]);
  expect(result.removed).toEqual([retired.path]);
  expect(readFileSync(join(root, original.path), "utf8")).toBe("new text");
  expect(readFileSync(join(root, "kordoc/my-template.hwpx"), "utf8")).toBe("personal template");
});

it("does not follow folder links or file links into other data", () => {
  const root = fixture(), outside = fixture();
  const linked = file(outside, "nested/old.exe", "old application");
  symlinkSync(join(outside, "nested"), join(root, "hop"), "junction");
  mkdirSync(join(root, "pdfcraft"));
  symlinkSync(join(outside, linked.path), join(root, "pdfcraft/old.exe"));
  const result = cleanupLegacyResources(root, [{ ...linked, path: "hop/old.exe" }, { ...linked, path: "pdfcraft/old.exe" }]);
  expect(result.removed).toEqual([]);
  expect(result.preserved).toHaveLength(2);
  expect(readFileSync(join(outside, linked.path), "utf8")).toBe("old application");
});

it("rejects a whole manifest before deletion if it includes traversal or live resources", () => {
  const root = fixture(), valid = file(root, "hop/old.exe", "old");
  for (const path of ["../data/state.sqlite", "hop/../../data", "hop\\old.exe", "hop/a:stream", "node/node.exe", "ieumoffice/resources/cli/genoffice.cjs", "ieumoffice/resources/wasm/rhwp_bg.wasm", "ieumoffice/WORKBENCH-BUNDLE.json"]) {
    expect(() => cleanupLegacyResources(root, [valid, { ...valid, path }])).toThrow("Invalid legacy");
    expect(existsSync(join(root, valid.path))).toBe(true);
  }
});

it("rejects a non-installation and an installation directory symlink", () => {
  const root = fixture(), outside = fixture(), valid = file(root, "hop/old.exe", "old");
  rmSync(join(root, "achmage-workbench.exe"));
  expect(() => cleanupLegacyResources(root, [valid])).toThrow();
  symlinkSync(root, join(outside, "linked"), "junction");
  expect(() => cleanupLegacyResources(join(outside, "linked"), [valid])).toThrow();
  expect(existsSync(join(root, valid.path))).toBe(true);
});

it("the pinned installer inventory excludes every currently retained resource", () => {
  expect(manifest.installerSha256).toBe("311e29629338db9b00ddb20537597415edbab26247139be4e836369309b154cd");
  expect(manifest.files).toHaveLength(910);
  expect(manifest.files.every(f => obsoleteResourcePath(f.path))).toBe(true);
  expect(new Set(manifest.files.map(f => f.path.toLowerCase())).size).toBe(manifest.files.length);
  expect(manifest.files.some(f => f.path === "ieumoffice/IeumOffice.exe")).toBe(true);
  expect(manifest.files.some(f => f.path === "ieumoffice/resources/app.asar")).toBe(true);
});

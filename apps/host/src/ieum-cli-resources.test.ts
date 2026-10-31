import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ieumFromCliDir } from "./ieumoffice.ts";
import { copyIeumCliResources } from "../../../scripts/ieum-cli-resources.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(["linux-x64", "win32-x64", "darwin-arm64"])("%s: the original CLI stays discoverable without an Electron app", (target) => {
  const root = mkdtempSync(join(tmpdir(), "wb-cli-resources-")); roots.push(root);
  const source = join(root, "original");
  const resources = join(source, target.startsWith("darwin") ? "IeumOffice.app/Contents/Resources" : "resources");
  const native = `native/xlsx-sidecar${target.startsWith("win32") ? ".exe" : ""}`;
  const files = ["cli/genoffice.cjs", "cli/node_modules/jsdom/package.json", "cli/skills/ieumoffice/SKILL.md", "wasm/pdfium.wasm", "wasm/hb-subset.wasm", "wasm/rhwp_bg.wasm", native, "ocr/vision-ocr", "ocr/win-ocr.exe", "LICENSE.txt", "NOTICE.txt", "LICENSE-UNICODE.txt", "THIRD-PARTY-NOTICES.txt", "modules/docs/index.html", "app.asar"];
  for (const file of files) { mkdirSync(dirname(join(resources, file)), { recursive: true }); writeFileSync(join(resources, file), file, { mode: 0o755 }); }
  const output = copyIeumCliResources(source, join(root, "bundled"), target);
  const install = ieumFromCliDir(join(output, "resources/cli"), true, target.split("-")[0] as NodeJS.Platform);
  expect(install).toMatchObject({ bundled: true, app: null, script: join(output, "resources/cli/genoffice.cjs") });
  expect(readFileSync(install!.script, "utf8")).toBe("cli/genoffice.cjs");
  expect(readFileSync(join(output, "resources", native), "utf8")).toBe(native);
  if (process.platform !== "win32") expect(statSync(join(output, "resources", native)).mode & 0o111).toBe(0o111);
  expect(readFileSync(join(output, "resources/NOTICE.txt"), "utf8")).toBe("NOTICE.txt");
  expect(existsSync(join(output, "resources/app.asar"))).toBe(false);
  expect(existsSync(join(output, "resources/modules"))).toBe(false);
  expect(readFileSync(join(resources, "app.asar"), "utf8")).toBe("app.asar");
  // An incomplete upstream release must fail before publishing a partial payload.
  rmSync(join(resources, "wasm/pdfium.wasm"));
  const incomplete = join(root, "incomplete");
  expect(() => copyIeumCliResources(source, incomplete, target)).toThrow("pdfium.wasm");
  expect(existsSync(incomplete)).toBe(false);
});

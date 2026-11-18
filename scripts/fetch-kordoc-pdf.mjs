// The kordoc core's own `pdf` extension (pdfjs-dist + @hyzyla/pdfium at the versions its lock names),
// prepared ONCE at build time exactly as the core prepares it itself (extensions.mjs prepareGroup:
// `npm ci --ignore-scripts` from the core's package-lock, then `.ready` = sha256 of that lock), so the
// app can read PDFs with KORDOC_OFFLINE=1 and never downloads anything at run time.
// Layout = the core's cache layout: <out>/<platform>-<arch>/pdf/{package.json, package-lock.json,
// node_modules, .ready}; the gateway points KORDOC_WORKBENCH_CACHE at <out> (hangul-convert.ts).
// Usage: node scripts/fetch-kordoc-pdf.mjs [out]   (default apps/desktop/src-tauri/kordoc-ext)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = join(root, "third_party/skills/hallym-kordoc/core/extensions/pdf");
const out = resolve(process.argv[2] ?? join(root, "apps/desktop/src-tauri/kordoc-ext"));
const dest = join(out, `${process.platform}-${process.arch}`, "pdf");
const lock = readFileSync(join(source, "package-lock.json"));
const hash = createHash("sha256").update(lock).digest("hex");

if (existsSync(join(dest, ".ready")) && readFileSync(join(dest, ".ready"), "utf8") === hash) {
  console.log(`kordoc pdf extension already prepared: ${dest}`);
} else {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(source, "package.json"), join(dest, "package.json"));
  writeFileSync(join(dest, "package-lock.json"), lock);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: dest, stdio: "inherit", shell: process.platform === "win32" });
  writeFileSync(join(dest, ".ready"), hash);
  console.log(`kordoc pdf extension prepared: ${dest}`);
}

// Fetch the independently built Windows engine using its pinned release manifest.
// Keep the native engine, runtime DLLs, licenses and source provenance together.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { NativeLightpandaBuild } from "../apps/host/src/browse-lightpanda.ts";

assert.equal(process.platform, "win32", "The native Windows package is bundled on Windows");
const manifest = JSON.parse(readFileSync(new URL("../packaging/lightpanda-windows.json", import.meta.url), "utf8")) as NativeLightpandaBuild;
const out = resolve(process.argv[2] ?? "apps/desktop/src-tauri/bundled");
mkdirSync(out, { recursive: true });
const temporary = mkdtempSync(join(out, ".lightpanda-"));
try {
  const response = await fetch(manifest.url, { signal: AbortSignal.timeout(180000) });
  assert.ok(response.ok, `Lightpanda download HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(archive).digest("hex"), manifest.sha256, "Lightpanda archive SHA-256");
  const file = join(temporary, "engine.zip"), unpacked = join(temporary, "engine");
  writeFileSync(file, archive); mkdirSync(unpacked);
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-xf", file, "-C", unpacked], { stdio: "inherit" });
  for (const [name, hash] of Object.entries(manifest.files)) {
    assert.match(name, /^[A-Za-z0-9_.-]+$/);
    assert.equal(createHash("sha256").update(readFileSync(join(unpacked, name))).digest("hex"), hash, `Lightpanda ${name} SHA-256`);
  }
  const dest = join(out, "lightpanda");
  rmSync(dest, { recursive: true, force: true });
  cpSync(unpacked, dest, { recursive: true });
  console.log(`Bundled native Windows Lightpanda ${manifest.version}: ${(archive.length / 1048576).toFixed(1)} MiB download`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

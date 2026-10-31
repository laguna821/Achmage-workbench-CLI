import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import manifest from "../../../packaging/windows-legacy-v0.2.2.json" with { type: "json" };
import { cleanupLegacyResources } from "./legacy-resources.ts";

if (process.platform !== "win32" || process.argv.length !== 3) throw new Error("Expected a Windows installation directory");
const root = resolve(process.argv[2]!);
const report = cleanupLegacyResources(root, manifest.files);
writeFileSync(join(root, "legacy-cleanup.json"), JSON.stringify({ from: manifest.release, ...report }, null, 2));
console.log(`Legacy application cleanup: ${report.removed.length} files, ${report.removedBytes} bytes; ${report.preserved.length} changed files preserved; ${report.failed.length} errors.`);
if (report.failed.length) process.exitCode = 1;

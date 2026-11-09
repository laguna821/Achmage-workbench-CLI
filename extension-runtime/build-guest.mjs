// Trusted build inputs only. This never reads or executes an installed extension.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({ absWorkingDir: root, entryPoints: ["vendor/paseo/plugin-host/guest-entry.ts"],
  bundle: true, platform: "neutral", format: "iife", globalName: "WorkbenchPaseoSdk",
  target: "es2020", outfile: "vendor/paseo/plugin-host/dist/guest-sdk.js", logLevel: "warning" });

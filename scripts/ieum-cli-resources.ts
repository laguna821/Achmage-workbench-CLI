import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Keep the original CLI and its engines; Workbench supplies the app and editor renderers. */
export function copyIeumCliResources(unpacked: string, destination: string, target: string) {
  const resources = target.startsWith("darwin-")
    ? join(unpacked, "IeumOffice.app", "Contents", "Resources")
    : join(unpacked, "resources");
  const native = target.startsWith("win32-") ? "xlsx-sidecar.exe" : "xlsx-sidecar";
  const required = [
    "cli/genoffice.cjs", "cli/node_modules/jsdom/package.json", "cli/skills/ieumoffice/SKILL.md",
    "wasm/pdfium.wasm", "wasm/hb-subset.wasm", "wasm/rhwp_bg.wasm", `native/${native}`,
    "LICENSE.txt", "NOTICE.txt", "LICENSE-UNICODE.txt", "THIRD-PARTY-NOTICES.txt",
    ...(target.startsWith("darwin-") ? ["ocr/vision-ocr"] : target.startsWith("win32-") ? ["ocr/win-ocr.exe"] : []),
  ];
  for (const file of required) {
    if (!existsSync(join(resources, file))) throw new Error(`IeumOffice CLI resource missing for ${target}: ${file}`);
  }
  // Never modify the source installation or a prior output in place. The caller stages a new folder.
  if (existsSync(destination)) throw new Error(`CLI resource destination already exists: ${destination}`);
  const output = join(destination, "resources");
  mkdirSync(output, { recursive: true });
  for (const name of ["cli", "wasm", "native", "ocr", "builtin-skills", "LICENSE.txt", "NOTICE.txt", "LICENSE-UNICODE.txt", "THIRD-PARTY-NOTICES.txt"]) {
    const from = join(resources, name);
    if (existsSync(from)) cpSync(from, join(output, name), { recursive: true });
  }
  cpSync(new URL("../packaging/ieumoffice-cli.cjs", import.meta.url), join(output, "cli/workbench-cli.cjs"));
  // install-cli links these launchers. They must also work outside an agent's PATH wrapper.
  writeFileSync(join(output, "cli/ieumoffice"), `#!/bin/sh
self="$0"
while [ -L "$self" ]; do
  target=$(readlink "$self")
  case "$target" in /*) self="$target" ;; *) self="$(dirname "$self")/$target" ;; esac
done
here=$(cd "$(dirname "$self")" && pwd)
root=$(cd "$here/../../.." && pwd)
if [ -n "$GENOFFICE_NODE" ]; then exec "$GENOFFICE_NODE" "$here/workbench-cli.cjs" "$@"; fi
for node in "$root/node/node" "$root/node/node.exe" "$root/../../lib/achmage-workbench/node/node" "$root/../../bin/node/node"; do
  if [ -x "$node" ]; then exec "$node" "$here/workbench-cli.cjs" "$@"; fi
done
exec node "$here/workbench-cli.cjs" "$@"
`, { mode: 0o755 });
  writeFileSync(join(output, "cli/ieumoffice.cmd"), '@echo off\r\nsetlocal\r\n"%~dp0..\\..\\..\\node\\node.exe" "%~dp0workbench-cli.cjs" %*\r\nexit /b %errorlevel%\r\n');
  return destination;
}

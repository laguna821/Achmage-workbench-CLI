import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";

// Compile once; a failed tool download must not recompile or rebuild a completed installer.
const cwd = fileURLToPath(new URL("../../apps/desktop/", import.meta.url));
const cli = fileURLToPath(new URL("../../node_modules/@tauri-apps/cli/tauri.js", import.meta.url));
const configs = ["tauri.release.conf.json", "tauri.release.apps.conf.json", "tauri.release.windows.conf.json"].flatMap(name => ["--config", `src-tauri/${name}`]);
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, ...configs], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let tail = "";
    for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.on("data", bytes => { output.write(bytes); tail = (tail + bytes.toString()).slice(-20_000); });
    }
    child.once("error", reject);
    child.once("close", code => resolve({ code, tail }));
  });
}
const built = await run(["build", "--no-bundle"]);
if (built.code !== 0) process.exit(built.code ?? 1);
for (const bundle of ["nsis", "msi"]) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await run(["bundle", "--bundles", bundle]);
    if (result.code === 0) break;
    const temporaryDownload = /http status:\s*(408|429|50[234])|connection (?:reset|timed out)|dns error|error sending request for url/i.test(result.tail);
    if (!temporaryDownload || attempt === 3) process.exit(result.code ?? 1);
    console.log(`Temporary ${bundle} download failure; retrying this bundle (${attempt + 1}/3).`);
    await setTimeout(attempt * 5_000);
  }
}

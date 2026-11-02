// Installs the actual locally built Windows ZIP through the product installer,
// then exercises the product gateway. No WSL or stand-in browser executable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LightpandaInstall, type NativeLightpandaBuild } from "../apps/host/src/browse-lightpanda.ts";

assert.equal(process.platform, "win32", "This acceptance test requires real Windows");
const archive = readFileSync(resolve(process.argv[2] ?? "lightpanda-windows-x64.zip"));
const packageDir = resolve(process.argv[3] ?? "native-package");
const output = resolve(process.argv[4] ?? "native-evidence");
mkdirSync(output, { recursive: true });
const source = JSON.parse(readFileSync(join(packageDir, "source-provenance.json"), "utf8"));
const files = JSON.parse(readFileSync(join(packageDir, "files.json"), "utf8")) as { name: string; sha256: string }[];
const root = mkdtempSync(join(tmpdir(), "wb-native-install-"));
const previousResources = process.env.WORKBENCH_RESOURCES_DIR;
const checks: string[] = [];
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
const server = createServer((_req, res) => { res.setHeader("Content-Length", archive.length); res.end(archive); });
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); assert.ok(address && typeof address !== "string");
const build: NativeLightpandaBuild = {
  version: source.engineVersion,
  url: `http://127.0.0.1:${address.port}/engine.zip`,
  sha256: createHash("sha256").update(archive).digest("hex"),
  files: Object.fromEntries(files.map(file => [file.name, file.sha256])),
};
const install = async (candidate: NativeLightpandaBuild) => {
  const installer = new LightpandaInstall(root, candidate);
  for (const step of installer.steps()) await step.run(() => {});
  return installer;
};
try {
  const legacy = join(root, "lightpanda"); mkdirSync(legacy);
  const previousRecord = JSON.stringify({ version: "1.0.2", sha256: "previous-install" });
  writeFileSync(join(legacy, "install.json"), previousRecord);
  writeFileSync(join(legacy, "lightpanda"), "previous-linux-binary");
  await assert.rejects(install({ ...build, sha256: "0".repeat(64) }), /SHA-256/);
  check("reject corrupted archive before activation", readFileSync(join(legacy, "install.json"), "utf8") === previousRecord);
  await assert.rejects(install({ ...build, files: { ...build.files, "lightpanda.exe": "0".repeat(64) } }), /SHA-256/);
  check("reject mismatched unpacked executable", readFileSync(join(legacy, "install.json"), "utf8") === previousRecord);
  await assert.rejects(install({ ...build, version: "0.0.0+wrong-version" }), /버전/);
  check("failed version verification preserves previous installation", readFileSync(join(legacy, "lightpanda"), "utf8") === "previous-linux-binary" && readFileSync(join(legacy, "install.json"), "utf8") === previousRecord);
  const installer = await install(build);
  check("verified native executable and runtime DLLs installed", installer.ready() && /\.exe$/i.test(installer.binary));
  check("legacy WSL binary preserved during migration", readFileSync(join(legacy, "lightpanda"), "utf8") === "previous-linux-binary");
  const resources = join(root, "resources");
  const bundledPath = join(resources, "lightpanda"); cpSync(packageDir, bundledPath, { recursive: true });
  process.env.WORKBENCH_RESOURCES_DIR = resources;
  const bundled = new LightpandaInstall(join(root, "bundled-data"), build);
  check("bundled engine ready without download or WSL setup", bundled.ready() && bundled.steps().length === 0 && bundled.binary === join(bundledPath, "lightpanda.exe"));
  const dll = files.find(file => /\.dll$/i.test(file.name)); assert.ok(dll, "package must contain runtime DLLs");
  writeFileSync(join(bundledPath, dll.name), "corrupt-runtime");
  const damaged = new LightpandaInstall(join(root, "repair-data"), build);
  check("corrupt bundled DLL is rejected", !damaged.ready() && damaged.binary !== bundled.binary);
  cpSync(join(packageDir, dll.name), join(bundledPath, dll.name));
  const browserReport = join(output, "native-installed-browser.json");
  await new Promise<void>((done, reject) => {
    const child = spawn(process.execPath, ["scripts/check-lightpanda.ts", bundled.binary, browserReport], { stdio: "inherit", env: { ...process.env, LIGHTPANDA_CHECK_HTTPS: "1" } });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? done() : reject(new Error(`Native installed browser check exited ${code}`)));
  });
  const browser = JSON.parse(readFileSync(browserReport, "utf8"));
  check("installed engine completed product checks without WSL", browser.wsl === false && browser.checks.length >= 15);
  writeFileSync(join(output, "native-install.json"), JSON.stringify({ checks, build, platform: process.platform, arch: process.arch }, null, 2));
} finally {
  if (previousResources === undefined) delete process.env.WORKBENCH_RESOURCES_DIR;
  else process.env.WORKBENCH_RESOURCES_DIR = previousResources;
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
}

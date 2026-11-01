// Installed-app acceptance: no install/link API call. The installer or first launch must
// prepare the official standalone app, whose real GUI is then run with Workbench stopped.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import type { Snapshot, ToolStatus } from "@workbench/contracts";
import { client, startGateway, type Gateway } from "./setup-smoke.ts";

type Check = (step: string, ok: boolean, detail?: string) => void;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function checkIeumSetup(app: string, outDir: string, check: Check) {
  mkdirSync(outDir, { recursive: true });
  const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
  const config = join(dataDir, "ieum-desktop.json");
  if (process.platform === "win32") {
    const installed = existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) : null;
    check("Windows 설치기 자체에서 이음 설치·등록·연결 완료", Boolean(installed?.setupVersion && installed.path && existsSync(installed.path) && installed.registration && existsSync(installed.registration) && !installed.setupError));
  }
  let gateway: Gateway | null = null, linked: ToolStatus | undefined;
  try {
    gateway = await startGateway(app, { WORKBENCH_IEUM_BOOTSTRAP: "1", WORKBENCH_SHELL_PATH: "0" }, dataDir);
    const { call } = client(gateway), before = (await call<Snapshot>("GET", "/api/snapshot")).tools?.ieumoffice;
    const deadline = Date.now() + 600_000;
    do {
      linked = (await call<Snapshot>("GET", "/api/snapshot")).tools?.ieumApp;
      if (linked?.setup === "ready" && !linked.busy || linked?.setup === "error" && !linked.busy) break;
      await delay(1000);
    } while (Date.now() < deadline);
    const ready = Boolean(linked?.setup === "ready" && linked.available && linked.registered && linked.path && existsSync(linked.path));
    check("별도 설치 조작 없이 공식 이음 독립 앱 자동 설치·등록·연결", ready, linked?.message ?? (ready ? `설정 완료 · ${linked?.version}` : "자동 설정 상태 없음"));
    const after = (await call<Snapshot>("GET", "/api/snapshot")).tools?.ieumoffice;
    check("자동 설치 후에도 내장 편집기 경로 유지", before?.path === after?.path && before?.bundled === after?.bundled);
    if (!ready || !linked?.path || !linked.registration) throw new Error(linked?.message ?? "Automatic Ieum setup did not finish");
    writeFileSync(join(outDir, "ieum-app-install.json"), JSON.stringify({ platform: process.platform, installed: linked, bundledBefore: before, bundledAfter: after }, null, 2));
  } finally { await gateway?.stop(); }
  check("Workbench 종료 후 독립 앱 검사 시작", gateway?.child.exitCode !== null || gateway?.child.signalCode !== null);
  const appPath = linked!.path!, entry = linked!.registration!;
  let registration: string;
  if (process.platform === "win32") {
    const script = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:IEUM_TEST_SHORTCUT); [Console]::Write($s.TargetPath)";
    registration = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", env: { ...process.env, IEUM_TEST_SHORTCUT: entry }, timeout: 30_000 }).trim();
    check("시작 메뉴의 독립 이음 앱 대상 확인", realpathSync(registration).toLowerCase() === realpathSync(appPath).toLowerCase(), entry);
  } else if (process.platform === "darwin") {
    registration = execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-dump"], { encoding: "utf8", maxBuffer: 20_000_000, timeout: 30_000 });
    check("macOS 독립 앱 Launch Services 등록 확인", registration.includes(entry), entry);
  } else {
    registration = readFileSync(entry, "utf8");
    execFileSync("desktop-file-validate", [entry], { timeout: 10_000 });
    const launcher = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "ieumoffice/launcher/ieumoffice-app.sh");
    check("Linux 앱 메뉴와 독립 실행기 대상 확인", registration.includes("Name=IeumOffice") && readFileSync(launcher, "utf8").includes(appPath), entry);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE; delete env.GENOFFICE_USER_DATA; delete env.GENOFFICE_AI_SETTINGS;
  const profile = mkdtempSync(join(tmpdir(), "wb-ieum-profile-"));
  if (process.platform === "linux") delete env.WAYLAND_DISPLAY;
  const application = await _electron.launch({ executablePath: appPath, args: ["--no-sandbox", `--user-data-dir=${profile}`, "--disable-dev-shm-usage", ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])], env, timeout: 60_000 });
  try {
    const page = await application.firstWindow({ timeout: 60_000 });
    await page.waitForFunction(() => (document.body?.innerText?.trim().length ?? 0) > 30, undefined, { timeout: 60_000 });
    const details = await application.evaluate(({ app }) => ({ name: app.getName(), version: app.getVersion(), executable: app.getPath("exe"), ready: app.isReady() }));
    const text = await page.locator("body").innerText();
    check("Workbench 없이 공식 이음 GUI 독립 실행", details.ready && details.version === linked?.version && realpathSync(details.executable) === realpathSync(appPath) && text.length > 30, `${details.name} ${details.version}`);
    await page.screenshot({ path: join(outDir, "ieum-standalone.png") });
    writeFileSync(join(outDir, "ieum-standalone.json"), JSON.stringify({ ...details, registration: entry, body: text.slice(0, 6000), workbenchExited: true }, null, 2));
  } finally { await application.close(); }
  const saved = readFileSync(config, "utf8");
  try {
    gateway = await startGateway(app, { WORKBENCH_IEUM_BOOTSTRAP: "1", WORKBENCH_SHELL_PATH: "0" }, dataDir);
    const reused = (await client(gateway).call<Snapshot>("GET", "/api/snapshot")).tools?.ieumApp;
    check("다시 열면 독립 앱 연결 재사용·중복 설치 없음", reused?.setup === "ready" && reused.registered === true && !reused.busy && reused.path === appPath && readFileSync(config, "utf8") === saved);
  } finally { await gateway?.stop(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results: { step: string; ok: boolean; detail?: string }[] = [], app = process.argv[2], out = process.argv[3];
  if (!app || !out || process.env.WORKBENCH_IEUM_ACCEPTANCE !== "1") throw new Error("Run only on a disposable CI account or an isolated test home: WORKBENCH_IEUM_ACCEPTANCE=1 node scripts/ieum-setup-check.ts <installed app resources> <evidence>");
  try { await checkIeumSetup(app, out, (step, ok, detail) => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); }); }
  catch (error) { results.push({ step: "자동 설치·독립 실행 완료", ok: false, detail: String(error) }); console.error(error); }
  finally { mkdirSync(out, { recursive: true }); writeFileSync(join(out, "ieum-setup-results.json"), JSON.stringify(results, null, 2)); }
  process.exitCode = results.every(row => row.ok) ? 0 : 1;
}

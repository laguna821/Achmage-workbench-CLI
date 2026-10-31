// First-run check of an installed app (release.yml, Windows and macOS; scripts/setup-check.ts runs
// the same on Linux): the bundled gateway on the bundled Node, with stand-in engines installed the
// ways people install them — an npm global install (codex.cmd/claude.cmd shims) on Windows,
// Homebrew and Claude Code's own installer on macOS, npm's prefix and ~/.local/bin on Linux —
// and a GUI app's short PATH. Checked through the API: both engines found (and where), both
// answer a request, kordoc, IeumOffice, PDFCraft and HOP ship with the app and work (text view and
// page pictures of a .docx, a .pptx and a .hwpx, a PDF page edit), and nothing says "설치되지 않음".
// Usage: node scripts/setup-smoke.ts <app resources folder> [out folder]
//   Windows: %LOCALAPPDATA%\Achmage Workbench   macOS: …/Achmage Workbench.app/Contents/Resources

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ProviderStatus, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

export type Result = { step: string; ok: boolean; detail: string };
export type Gateway = { url: string; token: string; dataDir: string; child: ChildProcess; stop: () => Promise<void> };

/** The app's node and gateway inside its resource folder. */
export function appLayout(app: string) {
  const node = join(app, "node", process.platform === "win32" ? "node.exe" : "node");
  return { node: existsSync(node) ? node : process.execPath, host: join(app, "host", "host.mjs"), web: join(app, "web") };
}

/** npm's .cmd shim for a JavaScript bin (cmd-shim), as `npm install -g` writes it. */
const cmdShim = (target: string) =>
  `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

/** A package folder with a stand-in engine as its JavaScript entry. */
function standInPackage(dir: string, name: string, entry: string, fake: string) {
  mkdirSync(dirname(join(dir, entry)), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0-fake", type: "module" }));
  copyFileSync(join(fixtures, fake), join(dir, entry));
  // The modules the stand-in engines import, next to them.
  for (const helper of ["png.mjs", "sample-reply.mjs"]) copyFileSync(join(fixtures, helper), join(dirname(join(dir, entry)), helper));
  return join(dir, entry);
}

/**
 * Stand-in engines where real installs put them, and the environment a GUI app starts with.
 * `expect` is how each engine should be reported as found.
 */
export function installStandIns(root: string, platform: NodeJS.Platform = process.platform) {
  const env: Record<string, string> = { WORKBENCH_SHELL_PATH: "0" };
  const cleanup: string[] = [];
  if (platform === "win32") {
    // npm install -g @openai/codex @anthropic-ai/claude-code: shims in %APPDATA%\npm, on PATH.
    const npm = join(root, "AppData", "Roaming", "npm");
    standInPackage(join(npm, "node_modules", "@openai", "codex"), "@openai/codex", join("bin", "codex.js"), "fake-codex.mjs");
    standInPackage(join(npm, "node_modules", "@anthropic-ai", "claude-code"), "@anthropic-ai/claude-code", "cli.js", "fake-claude.mjs");
    writeFileSync(join(npm, "codex.cmd"), cmdShim("node_modules\\@openai\\codex\\bin\\codex.js"));
    writeFileSync(join(npm, "claude.cmd"), cmdShim("node_modules\\@anthropic-ai\\claude-code\\cli.js"));
    const system = process.env.SystemRoot ?? "C:\\Windows";
    Object.assign(env, { APPDATA: join(root, "AppData", "Roaming"), PATH: [join(system, "System32"), system, npm].join(";") });
    return { env, cleanup, expect: { codex: { origin: "npm", path: join(npm, "codex.cmd") }, claude: { origin: "npm", path: join(npm, "claude.cmd") } } };
  }
  if (platform === "darwin") {
    // Homebrew's bin (not on a Finder PATH) and Claude Code's installer (~/.local/bin/claude).
    const codex = standInPackage(join(root, "brew", "codex"), "codex", "codex.js", "fake-codex.mjs");
    const claude = standInPackage(join(root, "claude"), "claude", "claude.js", "fake-claude.mjs");
    const brew = "/opt/homebrew/bin/codex";
    const local = join(homedir(), ".local", "bin", "claude");
    mkdirSync(dirname(local), { recursive: true });
    for (const [link, target] of [
      [brew, codex],
      [local, claude],
    ] as const) {
      if (existsSync(link)) throw new Error(`${link} already exists; this check would hide a real engine`);
      symlinkSync(target, link);
      cleanup.push(link);
    }
    Object.assign(env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
    return { env, cleanup, expect: { codex: { origin: "homebrew", path: brew }, claude: { origin: "native", path: local } } };
  }
  // Linux: npm's global prefix (bin → lib/node_modules) and ~/.local/bin, an AppImage's PATH.
  const home = join(root, "home");
  const prefix = join(root, "npm-global");
  standInPackage(join(prefix, "lib", "node_modules", "@openai", "codex"), "@openai/codex", join("bin", "codex.js"), "fake-codex.mjs");
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/@openai/codex/bin/codex.js", join(prefix, "bin", "codex"));
  const claude = standInPackage(join(home, ".local", "share", "claude"), "claude", "claude.js", "fake-claude.mjs");
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  symlinkSync(claude, join(home, ".local", "bin", "claude"));
  // Newer than any real engine on the computer running the check (Codex takes the newest it finds).
  Object.assign(env, { HOME: home, PATH: [join(prefix, "bin"), "/usr/bin", "/bin"].join(":"), FAKE_CODEX_VERSION: "999.0.0" });
  return { env, cleanup, expect: { codex: { origin: "npm", path: join(prefix, "bin", "codex") }, claude: { origin: "native", path: join(home, ".local", "bin", "claude") } } };
}

/** Start the app's gateway on the app's Node; resolves once it accepts requests. */
export async function startGateway(app: string, env: Record<string, string>, dataDir: string): Promise<Gateway> {
  const layout = appLayout(app);
  const child = spawn(layout.node, [layout.host], {
    env: { ...process.env, ...env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: layout.web, WORKBENCH_RESOURCES_DIR: app, WORKBENCH_HOST_LABEL: "확인" },
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the gateway did not start within 60 s")), 60_000);
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!line.startsWith("WORKBENCH_READY ")) return;
      clearTimeout(timer);
      done(JSON.parse(line.slice(16)));
    });
    child.on("exit", (code) => fail(new Error(`the gateway exited (${code})`)));
  });
  return {
    ...ready,
    dataDir,
    child,
    stop: () =>
      new Promise((done) => {
        if (child.exitCode !== null) return done();
        child.once("exit", () => done());
        child.kill();
        setTimeout(done, 5000);
      }),
  };
}

export function client(gateway: Pick<Gateway, "url" | "token">) {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${gateway.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const bytes = async (path: string) => {
    const response = await fetch(`${gateway.url}${path}`, { headers: { authorization: `Bearer ${gateway.token}` } });
    if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  return { call, bytes };
}

const until = async (what: () => Promise<boolean>, timeout: number) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what().catch(() => false)) return true;
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
};

/** A two-page PDF (Helvetica text), written by hand so the check needs no PDF library. */
export function minimalPdf() {
  const stream = "BT /F1 24 Tf 72 720 Td (Workbench) Tj ET";
  const page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    page,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    page,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** The checks; each result is recorded, a failure does not stop the others. */
export async function apiChecks(gateway: Gateway, app: string, expect: ReturnType<typeof installStandIns>["expect"], work: string, check: (step: string, ok: boolean, detail?: string) => void) {
  const { call, bytes } = client(gateway);
  const step = async (name: string, run: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await run();
      check(name, ok, detail);
    } catch (error) {
      check(name, false, error instanceof Error ? error.message : String(error));
    }
  };
  const providers = async () => (await call<Snapshot>("GET", "/api/snapshot")).providers;
  // Engines are looked for once the gateway accepts requests.
  await until(async () => (await providers()).every((status) => status.installed && status.loggedIn !== null), 60_000);
  const status = async (provider: "claude" | "codex") => (await providers()).find((entry) => entry.provider === provider) as ProviderStatus;

  for (const provider of ["codex", "claude"] as const) {
    await step(`${provider}: 설치된 엔진을 찾음 (${expect[provider].origin})`, async () => {
      const found = await status(provider);
      const same = (a: string | null) => (process.platform === "win32" ? a?.toLowerCase() === expect[provider].path.toLowerCase() : a === expect[provider].path);
      return [found.installed && found.origin === expect[provider].origin && same(found.binary), `installed=${found.installed} origin=${found.origin} binary=${found.binary} version=${found.version}`];
    });
    await step(`${provider}: 로그인 상태를 엔진에게서 읽음`, async () => {
      const found = await status(provider);
      return [found.loggedIn === true && found.loginMethod === "subscription", `loggedIn=${found.loggedIn} method=${found.loginMethod} plan=${found.plan}`];
    });
  }

  await step("문서 도구: 한글·PDF 내부 엔진과 문서 도구가 앱에 들어 있음", async () => {
    const tools = (await call<Snapshot>("GET", "/api/snapshot")).tools;
    const rows = { kordoc: tools.kordoc, ieumoffice: tools.ieumoffice, pdf: tools.pdf, hwp: tools.hwp };
    const ok = Object.values(rows).every((tool) => tool?.available && tool.bundled === true);
    return [ok, Object.entries(rows).map(([name, tool]) => `${name}=${tool?.available}/${tool?.bundled} ${tool?.version ?? ""}`).join(" · ")];
  });

  await step("별도 HOP·PDFCraft 앱이 설치본에 없음", async () => {
    const unwanted = ["hop", "pdfcraft"].filter(name => existsSync(join(app, name)));
    return [unwanted.length === 0, unwanted.join(", ")];
  });

  await step("'설치되지 않음'이 어디에도 없음 (상태와 화면 코드)", async () => {
    const snapshot = await call<Snapshot>("GET", "/api/snapshot");
    const missing = [...snapshot.providers.filter((entry) => !entry.installed).map((entry) => entry.provider), ...(["kordoc", "ieumoffice", "hwp", "pdf"] as const).filter((name) => !snapshot.tools[name]?.available)];
    const assets = join(appLayout(app).web, "assets");
    const scripts = existsSync(assets) ? readdirSync(assets).filter((name) => name.endsWith(".js")) : [];
    const said = scripts.filter((name) => readFileSync(join(assets, name), "utf8").includes("설치되지 않음"));
    return [missing.length === 0 && said.length === 0 && scripts.length > 0, `missing=[${missing.join(", ")}] ui=${scripts.length} scripts, saying it: [${said.join(", ")}]`];
  });

  mkdirSync(work, { recursive: true });
  const kordocForm = join(app, "kordoc", "templates", "간이기안문_서식.hwpx");
  copyFileSync(join(fixtures, "hello.docx"), join(work, "hello.docx"));
  copyFileSync(join(fixtures, "cover.pptx"), join(work, "cover.pptx"));
  if (existsSync(kordocForm)) copyFileSync(kordocForm, join(work, "form.hwpx"));
  const created = await call<Work>("POST", "/api/works", { title: "첫 실행 확인", cwd: work });
  const open = (name: string) => call<{ id: string }>("POST", `/api/works/${created.id}/artifacts`, { path: join(work, name) });

  for (const [name, expected] of [
    ["hello.docx", "안녕하세요"],
    ["cover.pptx", "가을 특강"],
  ] as const) {
    await step(`이음오피스: ${name} 글 보기`, async () => {
      const artifact = await open(name);
      const view = await call<{ text: string }>("GET", `/api/artifacts/${artifact.id}/text`);
      return [view.text.includes(expected), view.text.replace(/\s+/g, " ").slice(0, 80)];
    });
    await step(`이음오피스: ${name} 쪽 그림`, async () => {
      const artifact = await open(name);
      const started = Date.now();
      const pages = await call<{ pages: { page: number; width: number; height: number }[] }>("GET", `/api/artifacts/${artifact.id}/office-pages`);
      const png = pages.pages.length ? await bytes(`/api/artifacts/${artifact.id}/office-page?page=1`) : Buffer.alloc(0);
      return [pages.pages.length > 0 && png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), `${pages.pages.length}쪽, ${pages.pages[0]?.width}×${pages.pages[0]?.height}, ${png.length} bytes, ${Date.now() - started} ms`];
    });
  }

  await step("PDFCraft: PDF 쪽 돌리기·지우기 → 새 파일", async () => {
    writeFileSync(join(work, "two.pdf"), minimalPdf());
    const artifact = await open("two.pdf");
    const edited = await call<{ id: string; name: string }>("POST", `/api/artifacts/${artifact.id}/pdf-edit`, { rotate: [{ pages: [1], degrees: 90 }], delete: [2] });
    const bytes = readFileSync(join(work, edited.name));
    return [bytes.subarray(0, 5).toString() === "%PDF-" && bytes.includes("/Rotate"), `${edited.name} ${bytes.length} bytes`];
  });

  await step("kordoc: HWPX 글 보기와 쪽 미리보기", async () => {
    if (!existsSync(kordocForm)) return [false, `${kordocForm} 없음`];
    const artifact = await open("form.hwpx");
    const view = await call<{ text: string }>("GET", `/api/artifacts/${artifact.id}/text`);
    const pages = await call<{ pages: { svg: string }[] }>("GET", `/api/artifacts/${artifact.id}/pages`);
    return [view.text.includes("생산등록번호") && pages.pages.length > 0 && pages.pages[0]!.svg.includes("<svg"), `${view.text.split("\n")[0]} · ${pages.pages.length}쪽`];
  });

  for (const provider of ["codex", "claude"] as const) {
    await step(`${provider}: 찾은 엔진으로 요청에 답함`, async () => {
      const session = await call<Session>("POST", `/api/works/${created.id}/sessions`, { provider, purpose: "확인" });
      await call("POST", `/api/sessions/${session.id}/messages`, { requestId: `smoke-${provider}`, text: "안녕하세요" });
      let answer = "";
      const ok = await until(async () => {
        const items = (await call<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items;
        const reply = items.find((item) => item.kind === "assistant");
        answer = reply?.kind === "assistant" ? reply.text : "";
        return items.some((item) => item.kind === "turnEnd");
      }, 60_000);
      return [ok && answer.length > 0, answer.replace(/\s+/g, " ").slice(0, 60)];
    });
  }

  await step("엔진이 쓰는 이름: kordoc·ieumoffice 실행", async () => {
    const bin = join(gateway.dataDir, "bin");
    const run = (name: string, args: string[]) =>
      process.platform === "win32"
        ? execFileSync(join(bin, `${name}.cmd`), args, { encoding: "utf8", shell: true, timeout: 60_000 })
        : execFileSync("/bin/sh", [join(bin, name), ...args], { encoding: "utf8", timeout: 60_000 });
    const version = run("ieumoffice", ["--version"]).trim();
    const request = join(work, "kordoc-capabilities.json");
    writeFileSync(request, JSON.stringify({ schemaVersion: 1, mode: "capabilities" }));
    const capabilities = JSON.parse(run("kordoc", [request])) as { status?: string };
    return [/\d+\.\d+/.test(version) && capabilities.status !== "failed", `ieumoffice ${version} · kordoc ${capabilities.status}`];
  });
}

async function main() {
  const app = resolve(process.argv[2] ?? "");
  const outDir = resolve(process.argv[3] ?? join(tmpdir(), "wb-setup-smoke"));
  if (!existsSync(join(app, "host", "host.mjs"))) throw new Error(`No app at ${app} (host/host.mjs)`);
  mkdirSync(outDir, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "wb-smoke-"));
  const results: Result[] = [];
  const check = (step: string, ok: boolean, detail = "") => {
    results.push({ step, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
  };
  const standIns = installStandIns(root);
  let gateway: Gateway | null = null;
  try {
    gateway = await startGateway(app, standIns.env, join(root, "data"));
    await apiChecks(gateway, app, standIns.expect, join(root, "work"), check);
  } finally {
    await gateway?.stop();
    for (const link of standIns.cleanup) rmSync(link, { force: true });
    writeFileSync(join(outDir, "setup-smoke.json"), JSON.stringify(results, null, 2));
  }
  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

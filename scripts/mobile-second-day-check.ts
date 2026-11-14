/// <reference lib="dom" />
// "Does a phone still connect on the second day?" — the whole path in a real browser, on this
// machine only. A Chromium page stands in for the phone and opens the PC's remote listener.
// Nothing outside loopback is contacted: the two names used are mapped to 127.0.0.1 inside the
// browser and every other name fails to resolve. The gateway gets temp folders for its data and
// for both engines' configuration.
//
//   1. opened over plain http by a name that is not localhost (NOT a secure context, as a phone
//      on a network address would be): the page starts, says what http cannot do, and does not
//      offer to remember the connection. Opened by 127.0.0.1: not offered either. (no blank page)
//   2. opened over https by a second name: a TLS front made here (a certificate created for this
//      run, accepted by this browser only) passes bytes to the listener on 127.0.0.1, standing in
//      for the HTTPS proxy a private network would provide. Pair with "이 기기 기억하기" over
//      https/wss, approve at the PC                                      (remembered, with its date)
//   3. close the tab, restart the gateway                                (same remote port)
//   4. open a new tab: connect again with no approval at the PC          (the second day)
//   5. revoke at the PC: the page is cut off and forgets its credential
//
// Usage: node scripts/mobile-second-day-check.ts [outDir] [--start-only]
//   SECOND_DAY_HOST_ENTRY (default apps/host/dist/host.mjs), SECOND_DAY_WEB_DIR (default apps/web/dist)
//   --start-only: step 1 only, reporting what the page shows (for comparing another build).
// Run `npm run build -w @workbench/web` and `npm run build -w @workbench/host` first.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, createServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { DeviceGrant, PairingRequest, Work } from "@workbench/contracts";

const args = process.argv.slice(2);
const outDir = resolve(args.find((arg) => !arg.startsWith("--")) ?? join(tmpdir(), "wb-second-day"));
const startOnly = args.includes("--start-only");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-second-day-"));
const workDir = mkdtempSync(join(tmpdir(), "workbench-second-day-work-"));
const claudeConfig = mkdtempSync(join(tmpdir(), "workbench-second-day-claude-"));
const codexHome = mkdtempSync(join(tmpdir(), "workbench-second-day-codex-"));
const certDir = mkdtempSync(join(tmpdir(), "workbench-second-day-cert-"));
const PHONE_NAME = "phone.test", SECURE_NAME = "desk.test";

/** https on loopback in front of the listener: TLS ends here, the bytes go on to 127.0.0.1:port. */
async function tlsFront(port: number) {
  const key = join(certDir, "key.pem"), cert = join(certDir, "cert.pem");
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", `/CN=${SECURE_NAME}`, "-addext", `subjectAltName=DNS:${SECURE_NAME}`], { stdio: "ignore" });
  if (made.status !== 0) throw new Error("openssl로 검사용 인증서를 만들지 못했습니다.");
  const open = new Set<Socket>();
  const server = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    const upstream = connect(port, "127.0.0.1");
    for (const end of [socket, upstream]) { open.add(end); end.on("error", () => {}); end.on("close", () => { open.delete(end); socket.destroy(); upstream.destroy(); }); }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const at = server.address();
  return { port: typeof at === "object" && at ? at.port : 0, close: () => new Promise<void>((done) => { for (const end of open) end.destroy(); server.close(() => done()); }) };
}

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

type Ready = { url: string; token: string; port: number };
let child: ChildProcess | null = null;
async function startGateway(): Promise<Ready> {
  const started = spawn(process.execPath, [process.env.SECOND_DAY_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: dataDir,
      WORKBENCH_WEB_DIR: process.env.SECOND_DAY_WEB_DIR ?? "apps/web/dist",
      WORKBENCH_HOST_ID: "second-day-check",
      WORKBENCH_HOST_LABEL: "검사용 PC",
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
      WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      // Never the owner's engine configuration (plan usage, sessions).
      CLAUDE_CONFIG_DIR: claudeConfig,
      CODEX_HOME: codexHome,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child = started;
  return new Promise<Ready>((done, reject) => {
    started.once("error", reject);
    started.once("exit", (code) => reject(new Error(`Gateway exited before readiness (${code})`)));
    createInterface({ input: started.stdout! }).on("line", (line) => {
      if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)) as Ready);
    });
  });
}
/** Stops the gateway this script started, by its own handle, and waits until it is gone. */
async function stopGateway() {
  const running = child;
  child = null;
  if (!running || running.exitCode !== null) return;
  await new Promise<void>((done) => { running.once("exit", () => done()); running.kill("SIGTERM"); });
}

let ready = await startGateway();
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${value.message ?? ""}`);
  return value;
};
type Devices = { status: string; error?: string; port?: number | null; phoneUrl?: string | null; pending: PairingRequest[]; devices: DeviceGrant[] };
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};

const RESOLVER = `--host-resolver-rules=MAP ${PHONE_NAME} 127.0.0.1, MAP ${SECURE_NAME} 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;
const browser = await chromium.launch({ args: [RESOLVER] });
let front: Awaited<ReturnType<typeof tlsFront>> | null = null;
try {
  const work = await api<Work>("POST", "/api/works", { title: "둘째 날 프로젝트", folderId: null, cwd: workDir });
  // Loopback only, the default. The public address is only the name the page is opened by.
  const first = await api<Devices>("PUT", "/api/devices/config", { enabled: true, listenHost: "127.0.0.1", port: 0 });
  // A gateway built before the remote port was kept moves to a new port on every change: for
  // comparing such a build (--start-only) a free port is fixed by hand instead.
  const freePort = () => new Promise<number>((done, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const at = probe.address(); probe.close(() => done(typeof at === "object" && at ? at.port : 0)); });
  });
  const kept = typeof first.port === "number";
  const port = kept ? first.port! : await freePort();
  const insecureAddress = `http://${PHONE_NAME}:${port}`;
  const named = await api<Devices>("PUT", "/api/devices/config", { enabled: true, listenHost: "127.0.0.1", port: kept ? 0 : port, publicUrl: insecureAddress });
  if (!startOnly) {
    check("PC: 원격 연결 포트가 주소를 바꿔도 그대로", named.status === "listening" && named.port === port, `port ${first.port} → ${named.port}`);
    check("PC: 휴대폰이 열 수 있는 주소로 인식", named.phoneUrl === insecureAddress, String(named.phoneUrl));
  }

  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  const plain = await browser.newContext(phone);
  const errors: string[] = [], blocked: string[] = [];
  const watch = (page: import("playwright-core").Page) => {
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 200)));
    // What the page's security rules stopped, if anything.
    page.on("console", (message) => { if (/Content Security Policy|Refused to/i.test(message.text())) blocked.push(message.text().slice(0, 200)); });
  };
  const headline = (page: import("playwright-core").Page) => page.evaluate(() => document.querySelector(".host-connections-head p")?.textContent ?? "");
  const credentials = (page: import("playwright-core").Page) => page.evaluate(() => {
    const count = (storage: Storage) => Object.keys(storage).filter((key) => key.startsWith("workbench.remote-credential")).length;
    return { lasting: count(localStorage), tab: count(sessionStorage) };
  });

  // 1 — the page over plain http.
  const offer = await api<{ url: string }>("POST", "/api/devices/offers");
  const httpPage = await plain.newPage();
  watch(httpPage);
  await httpPage.goto(offer.url);
  await httpPage.waitForTimeout(1500);
  const start = await httpPage.evaluate(() => ({
    secure: window.isSecureContext, uuid: typeof crypto.randomUUID,
    rootText: (document.getElementById("root")?.textContent ?? "").length,
    dialog: Boolean(document.querySelector(".host-connections-dialog[open]")),
    notice: document.querySelector('[aria-label="http로 연 페이지"]')?.textContent ?? "",
    rememberOffered: Array.from(document.querySelectorAll(".host-connection-check")).some((label) => label.textContent?.includes("이 기기 기억하기") && !(label.querySelector("input") as HTMLInputElement).disabled),
    link: (document.querySelector(".host-connections-dialog textarea") as HTMLTextAreaElement | null)?.value.startsWith("http://") ?? false,
  }));
  await httpPage.screenshot({ path: join(outDir, "1-http-start.png") });
  if (startOnly) {
    console.log(`START ${JSON.stringify({ ...start, pageErrors: errors })}`);
  } else {
    check("휴대폰: 보안 컨텍스트가 아닌 http 페이지", start.secure === false, `isSecureContext=${start.secure}`);
    check("휴대폰: http에서도 화면이 뜸", start.rootText > 0 && start.dialog && errors.length === 0, `root ${start.rootText}자, dialog=${start.dialog}, errors=${errors.join(" | ") || "없음"}`);
    check("휴대폰: 연결 링크가 미리 채워짐", start.link);
    check("휴대폰: http에서 안 되는 것을 한 줄로 알림", start.notice.includes("카메라") && start.notice.includes("알림"), start.notice.slice(0, 80));
    check("휴대폰: http 페이지에서는 기억하기를 켤 수 없음", start.rememberOffered === false);
    await httpPage.close();

    // The same listener by this PC's own address: a secure context, yet nothing is kept there.
    const ownPage = await plain.newPage();
    watch(ownPage);
    await ownPage.goto(`http://127.0.0.1:${port}/`);
    await ownPage.waitForSelector(".host-connections-dialog[open]");
    const own = await ownPage.evaluate(() => ({ secure: window.isSecureContext, offered: !(document.querySelector(".host-connection-form .host-connection-check input") as HTMLInputElement).disabled,
      why: document.querySelector(".host-connection-form")?.textContent?.includes("이 PC 자신의 주소로 연 페이지에서는 연결을 기억하지 않습니다") ?? false }));
    check("휴대폰: 127.0.0.1로 연 페이지에서는 기억하기를 켤 수 없고 이유를 말함", own.secure === true && own.offered === false && own.why, JSON.stringify(own));
    await ownPage.close();
    await plain.close();

    // What the listener sends with its pages.
    const served = await fetch(`http://127.0.0.1:${port}/`);
    await served.arrayBuffer();
    const policy = served.headers.get("content-security-policy") ?? "";
    check("PC: 기기에 내주는 페이지에 보안 헤더", ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'"].every((part) => policy.includes(part)) && served.headers.get("x-content-type-options") === "nosniff", `${policy} · nosniff=${served.headers.get("x-content-type-options")}`);

    // 2 — pair, asking to remember, over https and wss.
    front = await tlsFront(port);
    const address = `https://${SECURE_NAME}:${front.port}`;
    const local = await api<Devices>("PUT", "/api/devices/config", { enabled: true, listenHost: "127.0.0.1", port: 0 });
    check("PC: 접속 주소를 지워도 포트는 그대로, 휴대폰이 닿을 주소는 없음", local.port === port && local.phoneUrl === null, `port ${local.port}, phoneUrl ${local.phoneUrl}`);
    const pasted = await api<{ url: string; qrDataUrl: string | null }>("POST", "/api/devices/offers");
    check("PC: 닿을 주소가 없으면 QR 없이 붙여넣기용 링크만", pasted.qrDataUrl === null && pasted.url.startsWith("workbench://"));
    const reachable = await api<Devices>("PUT", "/api/devices/config", { enabled: true, listenHost: "127.0.0.1", port: 0, publicUrl: address });
    const scanned = await api<{ url: string; qrDataUrl: string | null }>("POST", "/api/devices/offers");
    check("PC: 닿을 주소가 있으면 그 주소의 링크와 QR", reachable.port === port && reachable.phoneUrl === address && scanned.url.startsWith(address + "/#offer=") && Boolean(scanned.qrDataUrl?.startsWith("data:image/png")));
    // Only this run's certificate is waved through, and only in this browser context.
    const context = await browser.newContext({ ...phone, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    watch(page);
    await page.goto(scanned.url);
    await page.waitForSelector(".host-connections-dialog[open]");
    check("휴대폰: https로 연 페이지(보안 컨텍스트, 이 PC 자신의 주소가 아님)", await page.evaluate(() => window.isSecureContext && location.protocol === "https:" && !/^(localhost|127\.)/.test(location.hostname)) === true, address);
    check("휴대폰: https에서는 http 안내가 없음", await page.locator('[aria-label="http로 연 페이지"]').count() === 0);
    await page.getByLabel("이 기기의 이름").fill("검사 휴대폰");
    await page.getByLabel("이 기기 기억하기").check();
    await page.getByRole("button", { name: "연결 요청" }).click();
    const asked = await until(async () => await page.locator(".host-connection-verification strong").count() > 0);
    if (!asked) {
      const problem = await page.evaluate(() => [document.querySelector(".host-connections-head p")?.textContent, document.querySelector(".host-connections-error")?.textContent].filter(Boolean).join(" · "));
      await page.screenshot({ path: join(outDir, "2-pairing-failed.png") });
      throw new Error(`연결 요청이 확인번호까지 가지 못했습니다: ${problem} · ${errors.join(" | ")}`);
    }
    const shown = (await page.textContent(".host-connection-verification strong"))?.trim();
    let request: PairingRequest | undefined;
    await until(async () => Boolean(request = (await api<Devices>("GET", "/api/devices")).pending[0]));
    check("PC: 같은 확인번호, 기억 요청이 승인 전에 보임", Boolean(request) && request!.verificationCode === shown && request!.remember === true, `remember=${request?.remember}`);
    await api("POST", `/api/devices/enrollments/${request!.requestId}/approve`, { permissions: ["read"], workIds: [work.id] });
    const connected = await until(async () => (await headline(page)).includes("연결됨"));
    const firstDay = (await api<Devices>("GET", "/api/devices")).devices;
    check("휴대폰: 승인 뒤 연결됨", connected, await headline(page));
    check("PC: 기억된 기기로 표시(언제부터)", firstDay.length === 1 && typeof firstDay[0]!.rememberedAt === "number", `rememberedAt=${firstDay[0]?.rememberedAt}`);
    const stored = await credentials(page);
    check("휴대폰: 연결 권한이 탭이 아니라 브라우저에 보관됨", stored.lasting === 1 && stored.tab === 0, JSON.stringify(stored));

    // 3 — the tab closes; the PC's gateway restarts.
    await page.close();
    await stopGateway();
    ready = await startGateway();
    const restarted = await api<Devices>("GET", "/api/devices");
    check("PC: 게이트웨이를 다시 시작해도 원격 연결 포트가 같음", restarted.status === "listening" && restarted.port === port, `${port} → ${restarted.port} (${restarted.status}${restarted.error ? `: ${restarted.error}` : ""})`);

    // 4 — the second day: a new tab, the saved PC, no approval.
    const next = await context.newPage();
    watch(next);
    await next.goto(address + "/");
    await next.waitForSelector(".host-connections-dialog[open]");
    const before = await credentials(next);
    await next.getByRole("button", { name: "사용하기" }).click();
    const again = await until(async () => (await headline(next)).includes("연결됨"));
    const secondDay = await api<Devices>("GET", "/api/devices");
    check("휴대폰: 새 탭에는 탭 보관분이 없음", before.tab === 0 && before.lasting === 1, JSON.stringify(before));
    check("휴대폰: 다시 승인받지 않고 연결됨", again && secondDay.pending.length === 0 && secondDay.devices.length === 1, `${await headline(next)} · 승인 대기 ${secondDay.pending.length}`);
    await next.screenshot({ path: join(outDir, "4-second-day-connected.png") });
    // Behind the dialog: the PC's work as this device may see it. What else the page shows there
    // (first-run setup, refused requests) is reported as a note, not judged here.
    await next.getByRole("button", { name: "닫기", exact: true }).click();
    await next.waitForTimeout(1500);
    const behind = await next.evaluate(() => ({ setup: document.body.innerText.includes("작업을 시작할 준비"), refused: document.body.innerText.includes("이 기기에 허용되지 않은 작업입니다") }));
    console.log(`NOTE 연결 직후 화면: 첫 실행 설정 안내 ${behind.setup ? "보임" : "없음"}, ‘이 기기에 허용되지 않은 작업입니다’ ${behind.refused ? "보임" : "없음"}`);
    await next.screenshot({ path: join(outDir, "4-second-day-behind-dialog.png") });
    if (await next.getByRole("button", { name: "나중에 설정" }).count()) await next.getByRole("button", { name: "나중에 설정" }).click();
    if (await next.getByRole("button", { name: "사이드바 열기" }).count()) await next.getByRole("button", { name: "사이드바 열기" }).click();
    const sees = await until(async () => next.evaluate(() => document.body.innerText.includes("둘째 날 프로젝트")), 8000);
    check("휴대폰: 허용한 프로젝트가 보임", sees);
    await next.screenshot({ path: join(outDir, "4-second-day-project.png") });

    // 5 — the PC ends it.
    // The dialog is closed here: the top bar's connection button carries the state.
    const status = () => next.evaluate(() => document.querySelector(".shell-connections")?.getAttribute("aria-label") ?? "");
    const wasConnected = (await status()).includes("연결됨");
    await api("POST", `/api/devices/${secondDay.devices[0]!.deviceId}/revoke`);
    const cut = await until(async () => !(await status()).includes("연결됨"), 5000);
    check("PC에서 접근 철회: 휴대폰 연결이 바로 끊김", wasConnected && cut, `${wasConnected ? "연결됨" : "연결 안 됨"} → ${await status()}`);
    if (!(await next.locator(".host-connections-dialog[open]").count())) {
      // A side panel opened above may cover the top bar: the button is pressed by script, not by pointer.
      await next.evaluate(() => (document.querySelector(".shell-connections") as HTMLElement | null)?.click());
      await next.waitForSelector(".host-connections-dialog[open]");
    }
    await next.getByRole("button", { name: "사용하기" }).click();
    const refused = await until(async () => (await headline(next)).includes("연결 권한이 끝났습니다"));
    const after = await credentials(next);
    check("휴대폰: 다시 붙지 못하고 보관한 권한을 지움", refused && after.lasting === 0 && after.tab === 0, `${(await headline(next)).slice(0, 60)} · ${JSON.stringify(after)}`);
    await next.screenshot({ path: join(outDir, "5-revoked.png") });
    check("휴대폰: 페이지 오류 없음", errors.length === 0, errors.join(" | ") || "없음");
    check("휴대폰: 보안 헤더가 막은 것 없음", blocked.length === 0, blocked.join(" | ") || "없음");
    await context.close();
  }
} finally {
  await browser.close();
  await front?.close();
  await stopGateway();
  for (const folder of [dataDir, workDir, claudeConfig, codexHome, certDir]) rmSync(folder, { recursive: true, force: true });
}
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

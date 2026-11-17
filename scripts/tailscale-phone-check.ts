/// <reference lib="dom" />
// "휴대폰에서 테일스케일로 작업실 열기" — the whole road on this machine only, with STAND-INS:
//   · the `tailscale` CLI is scripts/fixtures/fake-tailscale.mjs (Tailscale is not installed here);
//   · Tailscale Serve is a TLS front made here: it ends HTTPS for desk.tail1a2b.ts.net with a
//     certificate created for this run and passes the bytes to whatever the stand-in's serve config
//     names (http://127.0.0.1:<device port>) — and to nothing when Tailscale is "stopped";
//   · the phone is Chromium at 390×844 (touch), which maps that one name to the front and fails
//     every other name. No outside host is contacted.
// Steps: PC 다시 확인 → ready, exact command → 켜기 → the phone opens the QR address → pair (six digits)
// → it lands on the approved project (no first-run wizard, no refused chip) → the panel says
// 휴대폰에서 열림 → conversation → send a line → the answer → approve a request → Tailscale stops (the
// phone and the panel say the road is gone) → it comes back → next day the page connects by itself →
// revoke at the PC ends it at once → the gateway stops: no serve session is left → it starts again: the
// road opens again by itself (켜기 stands) → the gateway is killed hard: the next start ends the leftover
// serve → the device port is busy at start: no serve until the listener holds it → 끄기 undoes exactly
// what 켜기 did, with no Tailscale command → a foreground Funnel on 443, and another program's session
// on 443, are refused.
//
// Usage: node scripts/tailscale-phone-check.ts [outDir]
//   TS_CHECK_HOST_ENTRY (default apps/host/dist/host.mjs), TS_CHECK_WEB_DIR (default apps/web/dist)
// Build first: npm run build -w @workbench/web && npm run build -w @workbench/host. Run through ux/run-isolated.sh.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { DeviceGrant, PairingRequest, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wb-tailscale-phone"));
mkdirSync(outDir, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "workbench-tailscale-check-"));
const dataDir = join(temp, "data"), workDir = join(temp, "work"), certDir = join(temp, "cert");
for (const dir of [dataDir, workDir, certDir, join(temp, "claude"), join(temp, "codex")]) mkdirSync(dir, { recursive: true });
const NAME = "desk.tail1a2b.ts.net", ADDRESS = `https://${NAME}`;
const FAKE = resolve("scripts/fixtures/fake-tailscale.mjs");
chmodSync(FAKE, 0o755);
const stateFile = join(temp, "tailscale-state.json"), callLog = join(temp, "tailscale-calls.log");
type Stand = { daemon: boolean; backend: string; dnsName: string; hostName: string; tailnet: string; magicDNS: boolean; certDomains: string[]; serve: Record<string, unknown> };
const stand = (patch: Partial<Stand> = {}) => {
  const current: Stand = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { daemon: true, backend: "Running", dnsName: NAME + ".", hostName: "desk", tailnet: "kim@example.com", magicDNS: true, certDomains: [NAME], serve: {} };
  writeFileSync(stateFile, JSON.stringify({ ...current, ...patch }, null, 2));
};
const standNow = () => JSON.parse(readFileSync(stateFile, "utf8")) as Stand;
const alive = (pid: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
/** The ports the stand-in's foreground serve sessions proxy to (the gateway's child is one of them). */
const sessionPorts = () => Object.values((standNow().serve as { Foreground?: Record<string, { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }> }).Foreground ?? {})
  .map((layer) => Number(/:(\d+)$/.exec(layer.Web?.[NAME + ":443"]?.Handlers?.["/"]?.Proxy ?? "")?.[1] ?? 0));
const changingCalls = () => existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]).filter((argv) => !argv.includes("--json")) : [];

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what().catch(() => false)) return true; await new Promise((done) => setTimeout(done, 150)); }
  return false;
};

/** Stand-in for Tailscale Serve: HTTPS for NAME, passed on to the stand-in serve config's proxy — or cut. */
async function serveFront() {
  const key = join(certDir, "key.pem"), cert = join(certDir, "cert.pem");
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", `/CN=${NAME}`, "-addext", `subjectAltName=DNS:${NAME}`], { stdio: "ignore" });
  if (made.status !== 0) throw new Error("openssl로 검사용 인증서를 만들지 못했습니다.");
  const open = new Set<Socket>();
  const target = () => {
    const state = standNow();
    if (!state.daemon || state.backend !== "Running") return null;
    type Layer = { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
    // Serve prefers a foreground session's handler over the background one.
    const serve = state.serve as Layer & { Foreground?: Record<string, Layer> };
    const proxy = [...Object.values(serve.Foreground ?? {}), serve].map((layer) => layer.Web?.[NAME + ":443"]?.Handlers?.["/"]?.Proxy).find(Boolean);
    const match = proxy ? /^http:\/\/127\.0\.0\.1:(\d+)$/.exec(proxy) : null;
    return match ? Number(match[1]) : null;
  };
  const server = createTlsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
    const port = target();
    if (!port) { socket.destroy(); return; }
    const upstream = connect(port, "127.0.0.1");
    for (const end of [socket, upstream]) { open.add(end); end.on("error", () => {}); end.on("close", () => { open.delete(end); socket.destroy(); upstream.destroy(); }); }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const at = server.address();
  return { port: typeof at === "object" && at ? at.port : 0, cut: () => { for (const end of open) end.destroy(); },
    close: () => new Promise<void>((done) => { for (const end of open) end.destroy(); server.close(() => done()); }) };
}

/**
 * The phone's only way out: an HTTP CONNECT proxy that admits exactly NAME:443 (to the Serve stand-in)
 * and refuses every other host — so nothing outside this machine can be reached from the page.
 */
async function phoneNetwork(frontPort: number) {
  const open = new Set<Socket>();
  const server = createNetServer((socket) => {
    open.add(socket); socket.on("close", () => open.delete(socket)); socket.on("error", () => {});
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n"); if (end < 0) { if (head.length > 8192) socket.destroy(); return; }
      socket.off("data", onData);
      const match = /^CONNECT ([^\s]+) HTTP\/1\.[01]\r\n/.exec(head);
      if (!match || match[1] !== `${NAME}:443`) { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
      const upstream = connect(frontPort, "127.0.0.1", () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); const rest = Buffer.from(head.slice(end + 4), "latin1"); if (rest.length) upstream.write(rest); socket.pipe(upstream).pipe(socket); });
      open.add(upstream); upstream.on("error", () => socket.destroy()); upstream.on("close", () => { open.delete(upstream); socket.destroy(); });
    };
    socket.on("data", onData);
  });
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const at = server.address();
  return { port: typeof at === "object" && at ? at.port : 0, close: () => new Promise<void>((done) => { for (const end of open) end.destroy(); server.close(() => done()); }) };
}

type Ready = { url: string; token: string };
let child: ChildProcess | null = null;
function startGateway(): Promise<Ready> {
  const started = spawn(process.execPath, [process.env.TS_CHECK_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: process.env.TS_CHECK_WEB_DIR ?? "apps/web/dist",
      WORKBENCH_HOST_ID: "tailscale-check", WORKBENCH_HOST_LABEL: "검사용 PC",
      WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
      CLAUDE_CONFIG_DIR: join(temp, "claude"), CODEX_HOME: join(temp, "codex"),
      WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
      WORKBENCH_TAILSCALE_BIN: FAKE, FAKE_TAILSCALE_STATE: stateFile, FAKE_TAILSCALE_LOG: callLog },
    stdio: ["ignore", "pipe", "inherit"],
  });
  child = started;
  return new Promise<Ready>((done, reject) => {
    started.once("error", reject);
    started.once("exit", (code) => reject(new Error(`Gateway exited before readiness (${code})`)));
    createInterface({ input: started.stdout! }).on("line", (line) => { if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)) as Ready); });
  });
}
async function stopGateway() {
  const running = child; child = null;
  if (!running || running.exitCode !== null) return;
  await new Promise<void>((done) => { running.once("exit", () => done()); running.kill("SIGTERM"); });
}

stand();
let ready = await startGateway();
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${value.message ?? ""}`);
  return value;
};
type Devices = { status: string; port?: number | null; phoneUrl?: string | null; config: { enabled: boolean; listenHost?: string; publicUrl?: string }; pending: PairingRequest[]; devices: DeviceGrant[] };
type Tail = { state: string; address?: string; command?: string[]; commandLine?: string; seenAt?: number | null; lost?: boolean; why?: string; ours: boolean; port: number };

const front = await serveFront();
const network = await phoneNetwork(front.port);
const browser = await chromium.launch();
const errors: string[] = [];
try {
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
  const work = await api<Work>("POST", "/api/works", { title: "테일스케일 프로젝트", folderId: null, cwd: workDir });
  const hidden = await api<Work>("POST", "/api/works", { title: "승인 안 한 프로젝트", folderId: null, cwd: workDir });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "휴대폰 대화" });
  // A Hangul document for the touch reading view (the page pictures come from the PC's hangulPages).
  copyFileSync(resolve("apps/host/src/channels/fixtures/강의계획서.hwpx"), join(workDir, "강의계획서.hwpx"));
  await api("POST", `/api/works/${work.id}/artifacts`, { path: "강의계획서.hwpx" });

  // ── PC: the panel's states from the stand-in CLI ──
  const before = await api<Devices>("GET", "/api/devices");
  const view = await api<Tail>("GET", "/api/devices/tailscale");
  check("PC: 준비됨 — 이 PC의 테일넷 이름으로 주소, 정확한 명령(--bg 없음)", view.state === "ready" && view.address === ADDRESS && view.commandLine === `tailscale serve --https=443 http://127.0.0.1:${view.port}`, `${view.state} ${view.commandLine}`);
  check("PC: 보기만 해서는 아무 명령도 실행하지 않음", changingCalls().length === 0);
  const on = await api<Tail>("POST", "/api/devices/tailscale/on", { command: view.command });
  const after = await api<Devices>("GET", "/api/devices");
  check("PC: 켜기 — 보인 명령 하나만 실행", JSON.stringify(changingCalls()) === JSON.stringify([view.command]), JSON.stringify(changingCalls()));
  check("PC: 켜짐 — 원격 연결 켜짐, 127.0.0.1에서만 받음, 주소 자동 채움", on.state === "on" && after.status === "listening" && after.config.listenHost === "127.0.0.1" && after.config.publicUrl === ADDRESS && after.port === view.port,
    `${on.state} · ${after.status} · ${after.config.listenHost} · ${after.config.publicUrl} · port ${after.port} (before: enabled=${before.config.enabled})`);
  check("PC: 아직 어떤 기기도 이 주소로 오지 않았으니 '휴대폰에서 열림' 없음", on.seenAt === null);
  check("PC: 켜기 — 앞에서 도는(foreground) Serve 하나, 테일스케일의 백그라운드 설정에는 아무것도 없음", sessionPorts().join() === String(view.port) && !(standNow().serve as { TCP?: unknown }).TCP, JSON.stringify(standNow().serve).slice(0, 160));

  // ── the phone ──
  const offer = await api<{ url: string; qrDataUrl: string | null }>("POST", "/api/devices/offers");
  check("PC: QR은 테일스케일 주소", offer.url.startsWith(ADDRESS + "/#offer=") && Boolean(offer.qrDataUrl), offer.url.slice(0, 40));
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true,
    proxy: { server: `http://127.0.0.1:${network.port}`, bypass: "<-loopback>" } });
  const consoleLines: string[] = [];
  const watch = (page: Page) => { page.on("pageerror", (error) => errors.push(error.message.slice(0, 200))); page.on("console", (message) => { if (message.type() === "error" || message.type() === "warning") consoleLines.push(`[${message.type()}] ${message.text().slice(0, 300)}`); }); };
  const page = await phone.newPage(); watch(page);
  const shot = (p: Page, name: string) => p.screenshot({ path: join(outDir, name) });
  await page.goto(offer.url);
  await page.waitForSelector(".host-connections-dialog[open]");
  check("휴대폰: https 테일스케일 주소로 열림(보안 컨텍스트)", await page.evaluate(() => window.isSecureContext && location.hostname.endsWith(".ts.net")));
  await shot(page, "phone-1-opened.png");
  await page.getByLabel("이 기기의 이름").fill("내 휴대폰");
  await page.getByLabel("이 기기 기억하기").check();
  await page.getByRole("button", { name: "연결 요청" }).click();
  const asked = await until(async () => await page.locator(".host-connection-verification strong").count() > 0);
  const code = asked ? (await page.textContent(".host-connection-verification strong"))?.trim() : "";
  await shot(page, "phone-2-six-digits.png");
  let request: PairingRequest | undefined;
  await until(async () => Boolean(request = (await api<Devices>("GET", "/api/devices")).pending[0]));
  check("PC와 휴대폰에 같은 여섯 자리", Boolean(code) && request?.verificationCode === code, String(code));
  await api("POST", `/api/devices/enrollments/${request!.requestId}/approve`, { permissions: ["read", "send", "approve"], workIds: [work.id] });

  // M01: lands on the PC's projects — the dialog closes by itself, no first-run wizard, no refused chip.
  const closed = await until(async () => await page.locator(".host-connections-dialog[open]").count() === 0, 15_000);
  await page.waitForTimeout(2000);
  const landing = await page.evaluate(() => ({ setup: document.body.innerText.includes("작업을 시작할 준비"), refused: document.body.innerText.includes("허용되지 않은 작업"), text: document.body.innerText.slice(0, 400) }));
  await shot(page, "phone-3-landed.png");
  check("M01 휴대폰: 연결되면 대화상자가 닫히고 첫 실행 안내가 없음", closed && !landing.setup, `closed=${closed} setup=${landing.setup}`);
  check("M01 휴대폰: '이 기기에 허용되지 않은 작업' 오류 없음", !landing.refused, landing.refused ? landing.text.replace(/\s+/g, " ").slice(0, 200) : "");
  const sees = await until(async () => page.evaluate(() => document.body.innerText.includes("테일스케일 프로젝트")), 8000);
  const leaks = await page.evaluate(() => document.body.innerText.includes("승인 안 한 프로젝트"));
  check("휴대폰: 승인한 프로젝트만 보임", sees && !leaks, `sees=${sees} other=${leaks}`);
  await shot(page, "phone-4-projects.png");
  const seen = await api<Tail>("GET", "/api/devices/tailscale");
  check("PC 패널: 기기가 그 주소로 들어온 뒤에야 '휴대폰에서 열림'", seen.state === "on" && typeof seen.seenAt === "number");

  // Conversation: open, send, answer, approve.
  const opened = await until(async () => {
    const target = page.locator("text=휴대폰 대화 >> visible=true").first();
    if (await target.count()) await target.click();
    return (await page.locator(".composer-input").count()) > 0;
  }, 10_000);
  await shot(page, "phone-5-conversation.png");
  check("휴대폰: 대화 열기", opened);
  if (opened) {
    await page.locator(".composer-input >> visible=true").first().fill("안녕하세요");
    await page.locator('button[aria-label="보내기"] >> visible=true').first().tap();
    const items = async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items;
    const answered = await until(async () => (await items()).some((item) => item.kind === "assistant"), 20_000);
    const answer = (await items()).filter((item) => item.kind === "assistant").map((item) => (item as { text?: string }).text ?? "").join("\n")
      .split("\n").map((line) => line.replace(/^[#>*\-\d.\s]+/, "").trim()).find((line) => line.length >= 8)?.slice(0, 16) ?? "";
    const shown = !!answer && await until(async () => page.evaluate((text) => (document.querySelector(".transcript")?.textContent ?? "").includes(text), answer), 10_000);
    check("휴대폰: 한 줄 보내고 답을 봄", answered && shown, `answered=${answered} shown=${shown}`);
    await shot(page, "phone-6-answer.png");
    await until(async () => (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === session.id)?.status !== "running", 15_000);
    await page.locator(".composer-input >> visible=true").first().fill("명령");
    await page.locator('button[aria-label="보내기"] >> visible=true').first().tap();
    const asking = await until(async () => (await page.locator(".approval-card .button.primary").count()) > 0, 20_000);
    await shot(page, "phone-7-approval.png");
    if (asking) await page.locator(".approval-card .button.primary").first().click();
    const decided = await until(async () => (await items()).some((item) => item.kind === "approval" && Boolean((item as { decision?: unknown }).decision)), 15_000);
    check("휴대폰: 요청 승인", asking && decided, `asked=${asking} decided=${decided}`);
    await shot(page, "phone-8-approved.png");
  }

  // Tailscale stops later: the road is gone, said on the phone and on the PC.
  const headline = async (p: Page) => {
    if (!(await p.locator(".host-connections-dialog[open]").count())) await p.evaluate(() => (document.querySelector(".shell-connections") as HTMLElement | null)?.click());
    await p.waitForSelector(".host-connections-dialog[open]", { timeout: 5000 }).catch(() => {});
    return p.evaluate(() => document.querySelector(".host-connections-dialog .host-connections-phase")?.textContent ?? "");
  };
  stand({ daemon: false }); front.cut();
  const goneOnPhone = await until(async () => (await headline(page)).includes("테일스케일이 켜져 있는지"), 15_000);
  check("Tailscale 꺼짐: 휴대폰이 길이 끊겼다고 말함", goneOnPhone, (await headline(page)).slice(0, 80));
  await shot(page, "phone-9-road-gone.png");
  let lost: Tail | null = null;
  await until(async () => Boolean((lost = await api<Tail>("GET", "/api/devices/tailscale")).why), 10_000);
  check("Tailscale 꺼짐: PC 패널이 길이 끊겼다고, 왜인지 말함", lost!.state === "stopped" && lost!.lost === true && Boolean(lost!.why), JSON.stringify(lost));
  stand({ daemon: true });
  // The gateway opens the road again by itself (back-off 5 s, 15 s, …) while 켜기 stands.
  const back = await until(async () => (await headline(page)).includes("연결됨"), 60_000);
  check("Tailscale 다시 켬: 휴대폰이 다시 붙음", back, (await headline(page)).slice(0, 80));

  // Next day: a new tab connects by itself (M01: no tap on 사용하기).
  await page.close();
  const next = await phone.newPage(); watch(next);
  await next.goto(ADDRESS + "/");
  const auto = await until(async () => next.evaluate(() => (document.querySelector(".shell-connections")?.getAttribute("aria-label") ?? "").includes("연결됨") && !document.querySelector(".host-connections-dialog[open]")), 15_000);
  check("M01 휴대폰: 다음 날 페이지를 열면 누르지 않아도 연결", auto);
  await shot(next, "phone-10-next-day.png");

  // A Hangul document in its touch reading view: one page picture, swipe, pinch.
  // The way a person goes: the sidebar (top-left), 문서 in the rail, the document.
  await next.evaluate(() => (document.querySelector(".topbar button[aria-label*='사이드바'], button[aria-label='사이드바 열기']") as HTMLElement | null)?.click());
  await next.waitForTimeout(600);
  await next.locator("nav >> text=문서 >> visible=true").first().click().catch(() => {});
  await next.waitForTimeout(800);
  await shot(next, "phone-12a-documents.png");
  const docRow = next.locator("text=강의계획서 >> visible=true").first();
  if (await docRow.count()) await docRow.click();
  await next.waitForTimeout(2500);
  const reading = await until(async () => (await next.locator(".hwpx-touch-stage img").count()) > 0, 30_000);
  await shot(next, "phone-12-hangul-page.png");
  let turned = "", zoomed = "";
  if (reading) {
    const box = (await next.locator(".hwpx-touch-stage").boundingBox())!;
    const total = await next.evaluate(() => document.querySelector(".hwpx-touch-bar .muted")?.textContent ?? "");
    // One finger sideways (CDP touch events, as a phone's browser sends them).
    const cdp = await phone.newCDPSession(next);
    const touch = async (type: string, points: { x: number; y: number }[]) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })) } as never);
    const y = box.y + box.height / 2;
    await touch("touchStart", [{ x: box.x + box.width * 0.8, y }]);
    for (const f of [0.7, 0.5, 0.3]) await touch("touchMove", [{ x: box.x + box.width * f, y }]);
    await touch("touchEnd", []);
    await next.waitForTimeout(300);
    turned = await next.evaluate(() => document.querySelector(".hwpx-touch-bar .muted")?.textContent ?? "");
    // Two fingers apart.
    const cx = box.x + box.width / 2;
    await touch("touchStart", [{ x: cx - 40, y }, { x: cx + 40, y }]);
    for (const d of [60, 90, 120]) await touch("touchMove", [{ x: cx - d, y }, { x: cx + d, y }]);
    await touch("touchEnd", []);
    await next.waitForTimeout(300);
    zoomed = (await next.locator(".hwpx-touch-stage").getAttribute("data-zoom")) ?? "";
    await shot(next, "phone-13-hangul-zoomed.png");
    check("휴대폰: 한글 문서를 쪽 그림으로 읽음, 손가락으로 넘김", /^1 \//.test(total) && (/^2 \//.test(turned) || /^1 \/ 1쪽/.test(total)), `${total} → ${turned}`);
    check("휴대폰: 두 손가락으로 확대", Number(zoomed) > 1, `zoom ${zoomed}`);
  } else check("휴대폰: 한글 문서를 쪽 그림으로 읽음, 손가락으로 넘김", false, "쪽 그림이 나오지 않음");

  // Revoke at the PC ends it at once.
  const device = (await api<Devices>("GET", "/api/devices")).devices[0]!;
  const t0 = Date.now();
  await api("POST", `/api/devices/${device.deviceId}/revoke`);
  const cut = await until(async () => next.evaluate(() => !(document.querySelector(".shell-connections")?.getAttribute("aria-label") ?? "").includes("연결됨")), 5000);
  check("PC에서 연결 끊기: 휴대폰이 바로 끊김", cut, `${Date.now() - t0} ms`);
  await shot(next, "phone-11-revoked.png");

  // The gateway stops (normal stop): the serve child and its session end with it.
  const servePid = () => { try { return (JSON.parse(readFileSync(join(dataDir, "remote-devices", "tailscale-serve.json"), "utf8")) as { pid: number }).pid; } catch { return 0; } };
  const first = servePid();
  await stopGateway();
  const none = await until(async () => sessionPorts().length === 0 && !alive(first), 5000);
  check("앱(게이트웨이)을 끄면: 테일스케일에 Serve가 남지 않음", none && first > 0, `pid ${first} · ${JSON.stringify(standNow().serve)}`);
  // It starts again: 켜기 stands, the road opens again by itself.
  ready = await startGateway();
  const reopened = await until(async () => (await api<Tail>("GET", "/api/devices/tailscale")).state === "on", 30_000);
  check("앱을 다시 켜면: 같은 명령으로 저절로 다시 열림", reopened && sessionPorts().join() === String(view.port), sessionPorts().join());
  // Killed hard (no chance to end its child): the next start ends the leftover before anything else.
  const leftover = servePid();
  await new Promise<void>((done) => { child!.once("exit", () => done()); child!.kill("SIGKILL"); });
  child = null;
  const orphan = alive(leftover) && sessionPorts().length === 1;
  ready = await startGateway();
  const ended = await until(async () => !alive(leftover) && (await api<Tail>("GET", "/api/devices/tailscale")).state === "on" && servePid() !== leftover && sessionPorts().length === 1, 30_000);
  check("게이트웨이가 강제로 죽은 뒤 다시 켜면: 남은 Serve를 먼저 끝내고 하나만 다시 엶", orphan && ended, `orphan=${orphan} pid ${leftover} → ${servePid()}`);
  // The device port is busy at start: no serve while the listener waits for it; it opens once the listener holds it.
  await stopGateway();
  await until(async () => sessionPorts().length === 0, 5000);
  const blocker = createNetServer();
  await new Promise<void>((done, reject) => { blocker.once("error", reject); blocker.listen(view.port, "127.0.0.1", () => done()); });
  const callsBefore = changingCalls().length;
  ready = await startGateway();
  await new Promise((done) => setTimeout(done, 3000));
  const waiting = await api<Devices>("GET", "/api/devices");
  const quiet = changingCalls().length === callsBefore && sessionPorts().length === 0 && waiting.status === "error";
  await new Promise<void>((done) => blocker.close(() => done()));
  const upAgain = await until(async () => (await api<Tail>("GET", "/api/devices/tailscale")).state === "on", 30_000);
  check("시작할 때 연결 포트가 막혀 있으면: 연결 받기가 그 포트를 잡기 전에는 Serve 없음, 잡은 뒤에 엶", quiet && upAgain && sessionPorts().join() === String(view.port),
    `quiet=${quiet} (${waiting.status}) up=${upAgain} ${sessionPorts().join()}`);

  // 끄기 undoes exactly what 켜기 did, and runs no Tailscale command.
  const off = await api<Tail>("POST", "/api/devices/tailscale/off");
  const restored = await api<Devices>("GET", "/api/devices");
  check("PC: 끄기 — 테일스케일 명령을 실행하지 않음(앱이 실행한 것은 보인 명령뿐)", changingCalls().every((argv) => JSON.stringify(argv) === JSON.stringify(view.command)), JSON.stringify(changingCalls()));
  check("PC: 끄기 — 원격 연결이 켜기 전 그대로, Serve 남지 않음", off.state === "ready" && restored.config.enabled === before.config.enabled && (restored.config.publicUrl ?? "") === (before.config.publicUrl ?? "") && JSON.stringify(standNow().serve) === "{}",
    `${off.state} enabled=${restored.config.enabled} publicUrl=${restored.config.publicUrl} serve=${JSON.stringify(standNow().serve)}`);
  // A Funnel or another program's session on 443, run in a terminal (foreground): refused, nothing run.
  const terminal = (layer: Record<string, unknown>) => ({ Foreground: { "terminal-session": { TCP: { 443: { HTTPS: true } }, Web: { [NAME + ":443"]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } }, ...layer } } });
  const refused = async (serve: Record<string, unknown>, state: string) => {
    stand({ serve });
    const seen = await api<Tail>("GET", "/api/devices/tailscale");
    const count = changingCalls().length;
    const pressed = await api<Tail>("POST", "/api/devices/tailscale/on", { command: ["serve", "--https=443", `http://127.0.0.1:${seen.port}`] }).then(() => "ran", (error: Error) => error.message);
    return { ok: seen.state === state && /409/.test(pressed) && changingCalls().length === count, detail: `${seen.state} · ${pressed.slice(0, 80)}` };
  };
  const funnel = await refused(terminal({ AllowFunnel: { [NAME + ":443"]: true } }), "funnel");
  check("터미널에서 켠 Funnel(443): 거절", funnel.ok, funnel.detail);
  const other = await refused(terminal({}), "taken");
  check("다른 프로그램의 Serve 세션(443): 거절, 덮어쓰지 않음", other.ok, other.detail);
  stand({ serve: {} });
  check("휴대폰: 페이지 오류 없음", errors.length === 0, errors.join(" | ") || "없음");
  await phone.close();
  await api("DELETE", `/api/works/${hidden.id}`).catch(() => {});
} finally {
  await browser.close();
  await network.close();
  await front.close();
  await stopGateway();
  rmSync(temp, { recursive: true, force: true });
}
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => !entry.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

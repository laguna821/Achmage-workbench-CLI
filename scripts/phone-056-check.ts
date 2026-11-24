/// <reference lib="dom" />
// 0.5.6 — the phone over Tailscale (ux/briefs/phone-remote-056-brief.md), through the SAME stand-ins as
// scripts/tailscale-phone-check.ts: the `tailscale` CLI is scripts/fixtures/fake-tailscale.mjs, Serve is a
// TLS front made here for desk.tail1a2b.ts.net, and the phone is Chromium (touch) whose only way out is a
// CONNECT proxy admitting that one name. No outside host, no real Tailscale, no real phone.
// Steps (phone 390×844, then 412×915; one dark frame):
//   1. pair (six digits, remembered) → the main screen carries no Doory line
//   2. a running Codex conversation with a long transcript, opened by its row → at its end, the composer on
//      screen, the page itself not scrolled — and still at its end when the turn ends
//   3. ⋯ → 새로 만들기 → 새 프로젝트… → made in the PC's projects folder, opened on the phone, in the phone's projects
//   4. ⋯ → 새로 만들기 → 새 문서 → 한글 문서 → 만들고 열기 → the .hwpx is in the project and opens on the phone
//   5. existing documents of every kind, opened from the list: what the phone shows (Hangul as page pictures)
//   6. the design editor on the phone: the Doory credit is its top line
// Usage: node scripts/phone-056-check.ts [outDir]
//   P056_HOST_ENTRY (default apps/host/dist/host.mjs), P056_WEB_DIR (default apps/web/dist)
// Build first (web → design → office → host). Run through ux/run-isolated.sh.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, createServer as createNetServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import type { Artifact, DeviceGrant, PairingRequest, Session, Snapshot, Work } from "@workbench/contracts";

const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wb-phone-056"));
mkdirSync(outDir, { recursive: true });
const temp = mkdtempSync(join(tmpdir(), "workbench-phone-056-"));
const dataDir = join(temp, "data"), workDir = join(temp, "work"), certDir = join(temp, "cert");
for (const dir of [dataDir, workDir, certDir, join(temp, "claude"), join(temp, "codex")]) mkdirSync(dir, { recursive: true });
const NAME = "desk.tail1a2b.ts.net";
const FAKE = resolve("scripts/fixtures/fake-tailscale.mjs");
chmodSync(FAKE, 0o755);
const stateFile = join(temp, "tailscale-state.json"), callLog = join(temp, "tailscale-calls.log");
writeFileSync(stateFile, JSON.stringify({ daemon: true, backend: "Running", dnsName: NAME + ".", hostName: "desk", tailnet: "kim@example.com", magicDNS: true, certDomains: [NAME], serve: {} }, null, 2));
const standNow = () => JSON.parse(readFileSync(stateFile, "utf8")) as { daemon: boolean; backend: string; serve: Record<string, unknown> };

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => { results.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await what().catch(() => false)) return true; await new Promise((done) => setTimeout(done, 150)); }
  return false;
};

/** Stand-in for Tailscale Serve (as in tailscale-phone-check.ts). */
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
  return { port: typeof at === "object" && at ? at.port : 0, close: () => new Promise<void>((done) => { for (const end of open) end.destroy(); server.close(() => done()); }) };
}
/** The phone's only way out: CONNECT to NAME:443, everything else refused. */
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
  const started = spawn(process.execPath, [process.env.P056_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
    env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: process.env.P056_WEB_DIR ?? "apps/web/dist",
      WORKBENCH_HOST_ID: "phone-056-check", WORKBENCH_HOST_LABEL: "검사용 PC",
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

const ready = await startGateway();
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${value.message ?? ""}`);
  return value;
};
type Devices = { pending: PairingRequest[]; devices: DeviceGrant[] };
type Tail = { state: string; command?: string[] };
const snapshot = () => api<Snapshot>("GET", "/api/snapshot");
const sessionOf = async (id: string) => (await snapshot()).sessions.find((entry) => entry.id === id)!;

const front = await serveFront();
const network = await phoneNetwork(front.port);
const browser = await chromium.launch();
const errors: string[] = [];
const refusals: string[] = [];
const DOORY = "Creator and maintainer of Doory";
try {
  await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
  const work = await api<Work>("POST", "/api/works", { title: "휴대폰 강의", folderId: null, cwd: workDir });
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "긴 대화" });
  // Documents of every kind the PC lists, in the project (fixtures and the PC's own blank documents).
  copyFileSync(resolve("apps/host/src/channels/fixtures/강의계획서.hwpx"), join(workDir, "강의계획서.hwpx"));
  copyFileSync(resolve("scripts/fixtures/hello.docx"), join(workDir, "인사.docx"));
  copyFileSync(resolve("scripts/fixtures/cover.pptx"), join(workDir, "표지.pptx"));
  copyFileSync(resolve("scripts/fixtures/supplies.xlsx"), join(workDir, "준비물.xlsx"));
  copyFileSync(resolve("scripts/fixtures/opendataloader/text.pdf"), join(workDir, "읽을거리.pdf"));
  writeFileSync(join(workDir, "수업 메모.md"), "# 수업 메모\n\n- 첫째 시간: 소개\n- 둘째 시간: 실습\n");
  writeFileSync(join(workDir, "안내.html"), "<!doctype html><meta charset=utf-8><h1>안내</h1><p>휴대폰에서 보는 HTML 문서입니다.</p>");
  writeFileSync(join(workDir, "읽기.txt"), "그냥 글입니다.\n둘째 줄.\n");
  const documents: Record<string, string> = {};
  for (const file of ["강의계획서.hwpx", "인사.docx", "표지.pptx", "준비물.xlsx", "읽을거리.pdf", "수업 메모.md", "안내.html", "읽기.txt"]) {
    const artifact = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: file });
    documents[file] = artifact.id;
  }
  const mind = await api<Artifact>("POST", `/api/works/${work.id}/office-documents`, { format: "xmind", name: "생각 정리" });
  documents["생각 정리.xmind"] = mind.id;
  const design = await api<Artifact>("POST", `/api/works/${work.id}/designs`, { name: "카드뉴스", preset: "square" });
  documents["카드뉴스.design.json"] = design.id;

  // A long transcript: two long answers at the PC first.
  const sendAtPc = (text: string) => api("POST", `/api/sessions/${session.id}/messages`, { requestId: `pc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text });
  for (let turn = 0; turn < 2; turn++) {
    await sendAtPc(`길게 ${turn + 1}`);
    await until(async () => (await sessionOf(session.id)).status === "running", 10_000);
    await until(async () => (await sessionOf(session.id)).status !== "running", 60_000);
  }

  // Remote access through the stand-in Tailscale, then pairing.
  const view = await api<Tail>("GET", "/api/devices/tailscale");
  await api<Tail>("POST", "/api/devices/tailscale/on", { command: view.command });
  const offer = await api<{ url: string }>("POST", "/api/devices/offers");
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true,
    colorScheme: "light", proxy: { server: `http://127.0.0.1:${network.port}`, bypass: "<-loopback>" } });
  const page = await phone.newPage();
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 200)));
  page.on("console", (message) => { if (message.type() === "error" && /허용되지 않은|CAPABILITY_DENIED|403/.test(message.text())) refusals.push(message.text().slice(0, 200)); });
  const shot = (name: string) => page.screenshot({ path: join(outDir, name) });
  await page.goto(offer.url);
  await page.waitForSelector(".host-connections-dialog[open]");
  await page.getByLabel("이 기기의 이름").fill("내 휴대폰");
  await page.getByLabel("이 기기 기억하기").check();
  await page.getByRole("button", { name: "연결 요청" }).click();
  let request: PairingRequest | undefined;
  await until(async () => Boolean(request = (await api<Devices>("GET", "/api/devices")).pending[0]));
  await api("POST", `/api/devices/enrollments/${request!.requestId}/approve`, { permissions: ["read", "send", "approve"], workIds: [work.id] });
  const paired = await until(async () => await page.locator(".host-connections-dialog[open]").count() === 0 && (await page.locator(".shell-connections").getAttribute("aria-label").catch(() => "") ?? "").includes("연결됨"), 20_000);
  check("연결: 휴대폰이 짝지어지고 승인한 프로젝트를 봄", paired);
  await page.waitForTimeout(1200);
  const toast = () => page.evaluate(() => [...document.querySelectorAll("[role=alert], [role=status], .toast")].map((node) => node.textContent ?? "").join(" | ").slice(0, 200));
  const bodyText = () => page.evaluate(() => document.body.innerText);
  check("첫 화면: Doory 줄이 앱 화면에 없음", !(await bodyText()).includes(DOORY));
  await shot("1-main-390.png");

  // ── 2. a running conversation with a long transcript, opened by its row ──
  await sendAtPc("길게 3");
  await until(async () => (await sessionOf(session.id)).status === "running", 10_000);
  await page.waitForTimeout(1500);
  const sidebar = async () => {
    if (await page.getByRole("button", { name: "사이드바 열기" }).count()) await page.getByRole("button", { name: "사이드바 열기" }).click();
    await page.waitForTimeout(400);
  };
  const inList = async (label: string) => {
    const row = page.locator(`.sidebar >> text=${label} >> visible=true`).first();
    if (!(await row.count())) return false;
    await row.click(); await page.waitForTimeout(500); return true;
  };
  const rail = async (place: string) => { await sidebar(); await page.locator(`.nav-rail >> text=${place} >> visible=true`).first().click().catch(() => {}); await page.waitForTimeout(500); };
  /** The conversation by its row: 프로젝트 → the project's row → the conversation's row (names as they are now). */
  const openConversation = async () => {
    const now = await snapshot(), title = now.works.find((entry) => entry.id === work.id)!.title, purpose = now.sessions.find((entry) => entry.id === session.id)!.purpose;
    await rail("프로젝트");
    if (!(await inList(purpose))) { await inList(title); await inList(purpose); }
  };
  /** A document by its row: 문서 → its row. */
  const openDocument = async (stem: string) => { await rail("문서"); await inList(stem); };
  await openConversation();
  const opened = await until(async () => (await page.locator(".composer-input >> visible=true").count()) > 0 && (await page.locator(".transcript >> visible=true").count()) > 0, 15_000);
  // Measured after two frames: what the person sees (layout and its observers have run), not a moment inside a render.
  const firstLook = async () => page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const scroller = [...document.querySelectorAll<HTMLElement>(".transcript")].find((node) => node.offsetParent !== null) ?? null;
    const composer = [...document.querySelectorAll<HTMLElement>(".composer-input")].find((node) => node.offsetParent !== null) ?? null;
    const box = composer?.getBoundingClientRect();
    const page = document.scrollingElement!;
    return {
      gap: scroller ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) : -1,
      tall: scroller ? scroller.scrollHeight > scroller.clientHeight * 2 : false,
      composerInView: Boolean(box && box.top >= 0 && box.bottom <= window.innerHeight),
      pageScrolled: Math.round(page.scrollTop), pageTaller: page.scrollHeight - window.innerHeight,
      doory: document.body.innerText.includes("Creator and maintainer of Doory"),
      ours: (scroller?.textContent ?? "").includes("번째 줄입니다"),
      follow: scroller?.closest(".transcript-wrap")?.getAttribute("data-follow-output") ?? null,
      band: Boolean(document.querySelector(".jump-band")),
    };
  });
  // The scroll rule, with no scroll by anyone: following the end stays on the whole time (no 새 응답 보기 band), the
  // composer is on screen, the page itself never moves, and every time the conversation's layout changes (an answer
  // streaming in, the panes resizing) the view is at its end before that frame is painted — read by a ResizeObserver
  // made after the app's own (its callbacks run after the app's in the same frame). Watched for ~2 s.
  const watchEnd = async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __wbGaps?: number[]; __wbGapWatch?: ResizeObserver };
      w.__wbGapWatch?.disconnect(); w.__wbGaps = [];
      const scroller = [...document.querySelectorAll<HTMLElement>(".transcript")].find((node) => node.offsetParent !== null);
      if (!scroller) return;
      const watch = new ResizeObserver(() => w.__wbGaps!.push(Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)));
      watch.observe(scroller); const inner = scroller.querySelector(".transcript-inner"); if (inner) watch.observe(inner);
      w.__wbGapWatch = watch;
    });
    const samples: Awaited<ReturnType<typeof firstLook>>[] = [];
    for (let at = 0; at < 6; at++) { samples.push(await firstLook()); await page.waitForTimeout(300); }
    const painted = await page.evaluate(() => { const w = window as unknown as { __wbGaps?: number[]; __wbGapWatch?: ResizeObserver }; w.__wbGapWatch?.disconnect(); return w.__wbGaps ?? []; });
    const last = samples.at(-1)!;
    const ok = samples.every((look) => look.follow === "true" && !look.band && look.composerInView && look.pageScrolled === 0 && look.pageTaller <= 0 && !look.doory && look.ours)
      && painted.every((gap) => gap <= 2) && last.tall;
    return { ok, detail: `frames ${painted.length}, largest gap before paint ${Math.max(0, ...painted)} · ` + JSON.stringify(samples.map((look) => ({ gap: look.gap, follow: look.follow, band: look.band, composer: look.composerInView, page: look.pageScrolled }))) };
  };
  await page.waitForTimeout(300);
  const first = await watchEnd();
  await shot("2-conversation-first-look-390.png");
  check("대화 첫 화면(390×844, 진행 중): 행을 누르면 긴 대화의 끝, 입력창이 화면 안, 페이지는 밀리지 않음", opened && first.ok, first.detail);
  await until(async () => (await sessionOf(session.id)).status !== "running", 60_000);
  await page.waitForTimeout(800);
  const ended = await watchEnd();
  check("대화(390): 답이 끝나도 끝에 머묾", ended.ok, ended.detail);
  // 412×915: another phone width, a freshly loaded page, the same conversation opened again from the list while it runs.
  await page.setViewportSize({ width: 412, height: 915 });
  await page.waitForTimeout(800);
  await sendAtPc("길게 4");
  await until(async () => (await sessionOf(session.id)).status === "running", 10_000);
  await page.reload();
  await until(async () => (await page.locator(".shell-connections").getAttribute("aria-label").catch(() => "") ?? "").includes("연결됨"), 20_000);
  await page.waitForTimeout(1200);
  await openConversation();
  await until(async () => (await page.locator(".composer-input >> visible=true").count()) > 0, 15_000);
  const wide = await watchEnd();
  await shot("2b-conversation-first-look-412.png");
  check("대화 첫 화면(412×915, 새로 연 페이지, 진행 중): 끝, 입력창이 화면 안", wide.ok, wide.detail);
  await until(async () => (await sessionOf(session.id)).status !== "running", 60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);

  // ── 2c. documents reached FROM the conversation (the owner, 2026-11-20: "권한이 없다면서 열리지도 않는다") ──
  // The conversation makes a file (a change card), the PC makes a document in it (its 문서 list), a request
  // names a document (a reference chip) and one from a project the phone does not hold.
  /** The turn ends; a request it asks for at the PC (approve a command) is declined there. */
  const settle = async () => {
    await page.waitForTimeout(1500);
    await until(async () => {
      const now = await sessionOf(session.id);
      if (now.status === "awaitingApproval") {
        const items = (await api<{ items: { kind: string; id: string; decision?: unknown }[] }>("GET", `/api/sessions/${session.id}/items`)).items;
        for (const item of items) if (item.kind === "approval" && !item.decision) await api("POST", `/api/sessions/${session.id}/approvals/${encodeURIComponent(item.id)}`, { decision: "decline" }).catch(() => undefined);
      }
      return now.status !== "running" && now.status !== "awaitingApproval";
    }, 60_000);
  };
  await sendAtPc("견본 슬라이드 구성 다시 짜 줘");
  await until(async () => (await sessionOf(session.id)).status === "running", 10_000);
  await settle();
  const inConversation = await api<Artifact>("POST", `/api/works/${work.id}/office-documents`, { format: "docx", name: "대화에서 만든 워드", sessionId: session.id });
  const hwpx = (await snapshot()).artifacts.find((entry) => entry.id === documents["강의계획서.hwpx"])!;
  const elsewhere = await api<Work>("POST", "/api/works", { title: "승인 안 한 프로젝트", folderId: null, cwd: null });
  writeFileSync(join(elsewhere.cwd, "남의 문서.md"), "# 남의 문서\n");
  const foreignDoc = await api<Artifact>("POST", `/api/works/${elsewhere.id}/artifacts`, { path: "남의 문서.md" });
  await api("POST", `/api/sessions/${session.id}/messages`, { requestId: `pc-ref-${Date.now()}`, text: "이 문서 참고해 줘", refs: [{ artifactId: hwpx.id, revision: hwpx.revision }] });
  await settle();
  await api("POST", `/api/sessions/${session.id}/messages`, { requestId: `pc-foreign-${Date.now()}`, text: "다른 프로젝트 문서도 봐 줘", refs: [{ artifactId: foreignDoc.id, revision: foreignDoc.revision }] });
  await settle();
  await sendAtPc("파일 링크 보여 줘");
  await settle();
  await page.reload();
  await until(async () => (await page.locator(".shell-connections").getAttribute("aria-label").catch(() => "") ?? "").includes("연결됨"), 20_000);
  await page.waitForTimeout(1200);
  type Opened = { entry: string; shows: string; line: string; banner?: { inside: boolean; under: boolean; cut: boolean } | null };
  const fromConversation: Opened[] = [];
  const seeDocument = async (entry: string, frame: string) => {
    await page.waitForTimeout(3500);
    const seen = await page.evaluate(() => {
      const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].some((node) => node.offsetParent !== null && node.getBoundingClientRect().height > 20);
      return {
        doc: visible(".doc-body") || visible(".doc-reading"),
        pages: visible(".hwpx-touch-stage img") || visible(".office-page img") || visible(".doc-body canvas"),
        text: visible(".doc-body .markdown, .doc-body .cm-content, .doc-body .doc-preview"),
        refused: /허용되지 않은|권한이 없|보호된 기기 연결이/.test(document.body.innerText),
        line: [...document.querySelectorAll(".top-notice-text")].map((node) => node.getAttribute("title") ?? node.textContent ?? "").join(" | ").slice(0, 600),
        // The top bar's notice at a phone's width: inside the screen, wrapped (never cut), never under the bar's keys.
        banner: (() => {
          const notice = document.querySelector<HTMLElement>(".top-notice");
          if (!notice) return null;
          const box = notice.getBoundingClientRect(), text = notice.querySelector<HTMLElement>(".top-notice-text");
          const keys = [...document.querySelectorAll<HTMLElement>(".topbar-right button, .topbar-left button")].filter((key) => key.offsetParent !== null);
          const under = keys.some((key) => { const b = key.getBoundingClientRect(); return !(box.right <= b.left || box.left >= b.right || box.bottom <= b.top || box.top >= b.bottom); });
          return { inside: box.left >= 0 && box.right <= window.innerWidth + 0.5, under, cut: text ? text.scrollWidth > text.clientWidth + 1 : false };
        })(),
        title: document.querySelector(".topbar-title")?.textContent ?? "",
      };
    });
    const shows = seen.refused ? "거절됨" : seen.pages ? "쪽 그림" : seen.text ? "내용" : seen.doc ? "문서 틀" : "열리지 않음";
    fromConversation.push({ entry, shows, line: seen.line, banner: seen.banner });
    await shot(frame);
  };
  const backToConversation = async () => { await openConversation(); await until(async () => (await page.locator(".composer-input >> visible=true").count()) > 0, 15_000); await page.waitForTimeout(800); };
  // a. the card of the file the turn made
  await backToConversation();
  const card = page.locator(".transcript .doc-card >> visible=true").first();
  if (await card.count()) { await card.click(); await seeDocument("대화가 만든 파일 카드", "2c-a-change-card-390.png"); } else fromConversation.push({ entry: "대화가 만든 파일 카드", shows: "카드 없음", line: "" });
  // b. the reference chip of a request
  await backToConversation();
  const chip = page.locator(".transcript .ref-chip >> visible=true").first();
  if (await chip.count()) { await chip.click(); await seeDocument("요청의 참조 문서 칩", "2c-b-ref-chip-390.png"); } else fromConversation.push({ entry: "요청의 참조 문서 칩", shows: "칩 없음", line: "" });
  // b2. a reference chip to a document of a project this phone does not hold
  await backToConversation();
  const foreignChip = page.locator(`.transcript .ref-chip >> text=${foreignDoc.name.replace(/\.md$/, "")} >> visible=true`).first();
  if (await foreignChip.count()) { await foreignChip.click(); await seeDocument("승인 안 한 프로젝트 문서의 칩", "2c-b2-foreign-chip-390.png"); }
  else { const chips = await page.locator(".transcript .ref-chip").allTextContents(); fromConversation.push({ entry: "승인 안 한 프로젝트 문서의 칩", shows: "칩 없음", line: chips.join(" | ") }); }
  // e. file links in an answer (absolute paths, as Codex writes them): tracked · in the project, not listed · outside
  let newTabs = 0;
  phone.on("page", () => { newTabs += 1; });
  for (const [label, entry, frame] of [["슬라이드 구성", "답의 파일 링크(목록에 있는 문서)", "2c-e1-link-listed-390.png"], ["링크 메모", "답의 파일 링크(프로젝트 폴더 안, 목록에 없던 파일)", "2c-e2-link-in-folder-390.png"], ["호스트 이름", "답의 파일 링크(프로젝트 밖)", "2c-e3-link-outside-390.png"]] as const) {
    await backToConversation();
    const link = page.locator(`.transcript .markdown a >> text=${label} >> visible=true`).last();
    if (await link.count()) { await link.click(); await seeDocument(entry, frame); } else fromConversation.push({ entry, shows: "링크 없음", line: "" });
  }
  // c. the conversation's 문서 list (the head's ⋯)
  await backToConversation();
  const more = page.locator(".note-head-more >> visible=true").first();
  if (await more.count()) {
    await more.click(); await page.waitForTimeout(500);
    await shot("2c-c-head-menu-390.png");
    const row = page.locator(`.note-menu >> text=${inConversation.name} >> visible=true`).first();
    if (await row.count()) { await row.click(); await seeDocument("대화의 문서 목록(⋯)", "2c-c-head-document-390.png"); } else fromConversation.push({ entry: "대화의 문서 목록(⋯)", shows: "목록에 없음", line: "" });
  } else fromConversation.push({ entry: "대화의 문서 목록(⋯)", shows: "⋯ 없음", line: "" });
  // d. the conversation's document tabs
  await backToConversation();
  const tab = page.locator(".doc-tabs .doc-tab-open >> visible=true").first();
  if (await tab.count()) { await tab.click(); await seeDocument("대화의 문서 탭", "2c-d-doc-tab-390.png"); } else fromConversation.push({ entry: "대화의 문서 탭", shows: "탭 없음", line: "" });
  console.log("from conversation", JSON.stringify(fromConversation, null, 1));
  const result = (entry: string) => fromConversation.find((row) => row.entry === entry) ?? { entry, shows: "없음", line: "" };
  const OUTSIDE = "휴대폰에 허용하지 않은 프로젝트의 문서라 열 수 없습니다";
  const OUTSIDE_FILE = "허용한 프로젝트 폴더 밖의 파일이라 휴대폰에서 열 수 없습니다";
  check("대화에서: 대화가 만든 파일 카드 → 문서가 열림(내용)", result("대화가 만든 파일 카드").shows === "내용", JSON.stringify(result("대화가 만든 파일 카드")));
  check("대화에서: 요청의 참조 문서 칩(한글) → 문서 목록과 같은 쪽 그림", result("요청의 참조 문서 칩").shows === "쪽 그림", JSON.stringify(result("요청의 참조 문서 칩")));
  check("대화에서: 승인 안 한 프로젝트 문서의 칩 → 한 줄로 까닭(권한 없음 아님), 열리지 않음", result("승인 안 한 프로젝트 문서의 칩").line.includes(OUTSIDE) && !/허용되지 않은 작업|권한이 없/.test(result("승인 안 한 프로젝트 문서의 칩").line), JSON.stringify(result("승인 안 한 프로젝트 문서의 칩")));
  check("대화에서: 대화의 문서 목록(⋯)의 워드 → 쪽 그림", result("대화의 문서 목록(⋯)").shows === "쪽 그림", JSON.stringify(result("대화의 문서 목록(⋯)")));
  check("대화에서: 답의 파일 링크(목록에 있는 문서) → 문서가 열림", result("답의 파일 링크(목록에 있는 문서)").shows === "내용", JSON.stringify(result("답의 파일 링크(목록에 있는 문서)")));
  check("대화에서: 답의 파일 링크(프로젝트 폴더 안) → 문서로 열림", result("답의 파일 링크(프로젝트 폴더 안, 목록에 없던 파일)").shows === "내용" && (await snapshot()).artifacts.some((entry) => entry.name === "링크 메모.md" && entry.workId === work.id), JSON.stringify(result("답의 파일 링크(프로젝트 폴더 안, 목록에 없던 파일)")));
  for (const entry of ["승인 안 한 프로젝트 문서의 칩", "답의 파일 링크(프로젝트 밖)"]) {
    const banner = result(entry).banner;
    check(`알림 줄(390): ${entry} — 화면 안, 줄바꿈(잘리지 않음), 위쪽 단추 밑으로 들어가지 않음`, Boolean(banner && banner.inside && !banner.under && !banner.cut), JSON.stringify(banner));
  }
  check("대화에서: 답의 파일 링크(프로젝트 밖) → 한 줄로 까닭, 문서·새 탭 없음", result("답의 파일 링크(프로젝트 밖)").line.includes(OUTSIDE_FILE) && result("답의 파일 링크(프로젝트 밖)").shows !== "내용" && newTabs === 0, `${JSON.stringify(result("답의 파일 링크(프로젝트 밖)"))} · new tabs ${newTabs}`);
  writeFileSync(join(outDir, "from-conversation.json"), JSON.stringify(fromConversation, null, 2));
  void foreignDoc;

  // ── 3. 새 프로젝트 ──
  const before = (await snapshot()).works.map((entry) => entry.id);
  const createMenu = async () => {
    await page.locator('button[aria-label="더 보기"][title="작업 현황, 화면, 설정"] >> visible=true').first().click();
    await page.locator(".compact-toolbar-menu .shell-create >> visible=true").first().click();
    await page.waitForSelector("[role=menu] >> visible=true", { timeout: 5000 });
  };
  await createMenu();
  await shot("3a-create-menu-390.png");
  await page.locator("[role=menuitem] >> text=새 프로젝트… >> visible=true").first().click();
  let made: Work | undefined;
  await until(async () => Boolean(made = (await snapshot()).works.find((entry) => !before.includes(entry.id))), 15_000);
  const grant = (await api<Devices>("GET", "/api/devices")).devices[0]!;
  const onPhone = made ? await until(async () => (await page.evaluate(() => document.querySelector(".topbar-title")?.textContent ?? "")).includes("새 프로젝트"), 20_000) : false;
  await page.waitForTimeout(800);
  await shot("3b-new-project-390.png");
  check("새 프로젝트(휴대폰): PC의 기본 프로젝트 폴더에 만들어지고 휴대폰에서 열림",
    Boolean(made) && made!.title === "새 프로젝트" && !made!.cwd.startsWith(workDir) && onPhone, `${made?.title} · ${made?.cwd} · opened=${onPhone} · ${await toast()}`);
  check("새 프로젝트(휴대폰): 이 휴대폰이 볼 수 있는 프로젝트에 더해짐(다른 프로젝트는 그대로)", Boolean(made) && grant.workIds.includes(made!.id) && grant.workIds.includes(work.id) && grant.workIds.length === 2, JSON.stringify(grant.workIds));
  // Its row in the list waits for its name (as on the PC): type it there.
  const naming = page.locator(".sidebar input >> visible=true").first();
  if (await naming.count()) { await naming.fill("휴대폰 수업"); await naming.press("Enter"); }
  const named = made ? await until(async () => (await snapshot()).works.find((entry) => entry.id === made!.id)?.title === "휴대폰 수업", 10_000) : false;
  await page.waitForTimeout(600);
  await shot("3c-new-project-named-390.png");
  check("새 프로젝트(휴대폰): 목록에서 이름을 지어 줌(PC와 같은 길)", named, `${(await snapshot()).works.find((entry) => entry.id === made?.id)?.title} · ${await toast()}`);
  await page.keyboard.press("Escape").catch(() => {});

  // ── 4. 새 문서 → 한글 문서 ──
  const artifactsBefore = (await snapshot()).artifacts.map((entry) => entry.id);
  await createMenu();
  await page.locator("[role=menuitem] >> text=새 문서 >> visible=true").first().click();
  await page.locator("[role=menuitem] >> text=새 한글 문서 >> visible=true").first().click();
  const dialog = await until(async () => (await page.locator(".new-document-dialog[open]").count()) > 0, 5000);
  await shot("4a-new-document-dialog-390.png");
  if (dialog) await page.getByRole("button", { name: "만들고 열기" }).click();
  let doc: Artifact | undefined;
  await until(async () => Boolean(doc = (await snapshot()).artifacts.find((entry) => !artifactsBefore.includes(entry.id))), 15_000);
  const pages = doc ? await until(async () => (await page.locator(".hwpx-touch-stage img >> visible=true").count()) > 0, 40_000) : false;
  await page.waitForTimeout(600);
  await shot("4b-new-hangul-390.png");
  check("새 문서(휴대폰): 한글 문서가 프로젝트에 만들어짐", Boolean(doc) && doc!.format === "hwpx" && doc!.workId === made?.id, `${doc?.name} · ${doc?.workId === made?.id ? "새 프로젝트" : doc?.workId} · ${await toast()}`);
  check("새 문서(휴대폰): 만든 한글 문서가 휴대폰에서 열림(쪽 그림)", pages, await toast());

  // ── 5. existing documents of every kind, opened from the list ──
  const kinds: { file: string; shows: string }[] = [];
  for (const file of Object.keys(documents)) {
    await openDocument(file.replace(/(\.design)?\.[^.]+$/, ""));
    await page.waitForTimeout(3500);
    const seen = await page.evaluate(() => {
      const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].some((node) => node.offsetParent !== null && node.getBoundingClientRect().height > 20);
      return {
        pages: visible(".hwpx-touch-stage img") || visible(".office-page img") || visible(".doc-body canvas"),
        text: visible(".markdown-preview, .doc-preview, .markdown, .doc-text, .cm-content, .doc-html, iframe"),
        skeleton: visible(".doc-skeleton"),
        refused: /허용되지 않은|보호된 기기 연결이/.test(document.body.innerText),
        error: [...document.querySelectorAll("[role=alert]")].map((node) => node.textContent ?? "").join(" | ").slice(0, 160),
        title: document.querySelector(".topbar-title")?.textContent ?? "",
      };
    });
    const shows = seen.refused ? "거절됨" : seen.pages ? "쪽 그림" : seen.skeleton ? "빈 틀" : seen.text ? "내용" : "보이는 것 없음";
    kinds.push({ file, shows: `${shows}${seen.error ? ` · ${seen.error}` : ""}` });
    await shot(`5-open-${file.replace(/[^\w가-힣.]/g, "_")}-390.png`);
  }
  console.log(JSON.stringify(kinds, null, 1));
  const hangul = kinds.find((entry) => entry.file === "강의계획서.hwpx")!;
  check("있는 한글 문서(.hwpx): 휴대폰에서 쪽 그림으로 열림", hangul.shows.startsWith("쪽 그림"), hangul.shows);
  for (const file of ["인사.docx", "표지.pptx", "읽을거리.pdf"]) {
    const entry = kinds.find((kind) => kind.file === file)!;
    check(`있는 ${file.split(".").pop()} 문서: 휴대폰에서 쪽 그림으로 열림`, entry.shows.startsWith("쪽 그림"), entry.shows);
  }
  check("있는 문서 모든 종류: 거절·빈 틀 없이 무언가를 보여 줌", kinds.every((entry) => !/^(거절됨|빈 틀)/.test(entry.shows) && !entry.shows.startsWith("보이는 것 없음")), kinds.map((entry) => `${entry.file}: ${entry.shows}`).join(" / "));
  writeFileSync(join(outDir, "kinds.json"), JSON.stringify(kinds, null, 2));

  // ── 6. the design editor on the phone: the Doory credit is its top line ──
  await openDocument("카드뉴스");
  type Credit = { text: string; top: number; barTop: number; cut: boolean; size: number; readOnly: boolean };
  let seen: Credit | null = null;
  const credit = await until(async () => {
    for (const frame of page.frames()) {
      const found = await frame.evaluate((): Credit | null => {
        const line = document.querySelector<HTMLElement>(".wb-design-credit"), bar = document.querySelector<HTMLElement>("[data-testid=ed-topbar]");
        if (!line || !bar) return null;
        return { text: line.textContent ?? "", top: line.getBoundingClientRect().top, barTop: bar.getBoundingClientRect().top, cut: line.scrollWidth > line.clientWidth + 1,
          size: parseFloat(getComputedStyle(line).fontSize), readOnly: (document.querySelector(".wb-design-rev")?.textContent ?? "").includes("읽기 전용") };
      }).catch(() => null);
      if (found?.text.includes(DOORY)) { seen = found; return true; }
    }
    return false;
  }, 40_000);
  await page.waitForTimeout(800);
  await shot("6-design-credit-390.png");
  const line = seen as Credit | null;
  check("디자인(휴대폰): 열림(읽기 전용), 맨 위 줄에 Doory 저작자 표시 — 잘리지 않고 12px 이상, 메뉴 줄 위", credit && Boolean(line && line.readOnly && line.top < line.barTop && !line.cut && line.size >= 12), JSON.stringify(line));

  // ── 9. Round 2 (owner, 2026-11-20): every phone action works inside its projects, or is not offered ──
  const r2 = async (step: string, run: () => Promise<{ ok: boolean; detail: string }>, frame: string) => {
    try { const result = await run(); await shot(frame); check(step, result.ok, result.detail); }
    catch (error) { await shot(frame).catch(() => undefined); check(step, false, (error as Error).message.slice(0, 200)); }
    await page.keyboard.press("Escape").catch(() => undefined); await page.waitForTimeout(300);
  };
  const item = (name: string) => page.getByRole("menuitem", { name }).first();
  const rowMenu = async (place: string, label: string) => {
    await rail(place);
    const more = page.locator(`.sidebar button[aria-label="${label} 더 보기"]`).first();
    if (!(await more.count())) { await inList(label); await rail(place); }
    await page.locator(`.sidebar button[aria-label="${label} 더 보기"]`).first().click({ force: true });
    await page.waitForSelector("[role=menu] >> visible=true", { timeout: 5000 });
  };
  /** A document row's menu: a long press on a phone (the browser's contextmenu). */
  const docMenu = async (name: string) => {
    await rail("문서");
    await page.locator(`.sidebar >> text="${name}" >> visible=true`).first().click({ button: "right" });
    await page.waitForSelector("[role=menu] >> visible=true", { timeout: 5000 });
  };
  const workNow = async () => (await snapshot()).works.find((entry) => entry.id === work.id)!;
  const workTitle = async () => (await workNow()).title;
  await r2("2차: 목록에 새 폴더 (새로 만들기 → 목록에 새 폴더…) → 휴대폰에서 만들고 이름 지음", async () => {
    await createMenu(); await item("목록에 새 폴더…").click();
    const field = page.locator('input[aria-label="새 폴더 이름"] >> visible=true').first();
    await field.waitFor({ timeout: 5000 }); await field.fill("휴대폰 분류"); await field.press("Enter");
    const ok = await until(async () => (await snapshot()).folders.some((folder) => folder.name === "휴대폰 분류"), 10_000);
    return { ok, detail: JSON.stringify((await snapshot()).folders.map((folder) => folder.name)) };
  }, "9a-list-folder-390.png");
  await r2("2차: 프로젝트 → 고정, 폴더로 옮기기", async () => {
    const title = await workTitle();
    await rowMenu("프로젝트", title); await item("고정").click();
    await until(async () => (await workNow()).pinned === true, 8000);
    await rowMenu("프로젝트", title); await item("옮기기").click(); await page.waitForTimeout(400);
    await page.locator('[role=menu] >> text="휴대폰 분류" >> visible=true').last().click();
    const folder = (await snapshot()).folders.find((entry) => entry.name === "휴대폰 분류");
    const ok = await until(async () => (await workNow()).folderId === folder?.id, 8000);
    return { ok: ok && (await workNow()).pinned === true, detail: JSON.stringify({ pinned: (await workNow()).pinned, folderId: (await workNow()).folderId, folder: folder?.id }) };
  }, "9b-project-pin-move-390.png");
  await r2("2차: 프로젝트 삭제… 는 휴대폰에서 꺼져 있고 까닭 한 줄", async () => {
    await rowMenu("프로젝트", await workTitle());
    const entry = item("프로젝트 삭제…");
    const disabled = (await entry.getAttribute("aria-disabled")) === "true" || (await entry.isDisabled().catch(() => false));
    return { ok: disabled && (await page.locator("text=프로젝트 삭제는 PC에서 합니다").count()) + 1 > 0, detail: `disabled=${disabled}` };
  }, "9c-project-delete-off-390.png");
  await r2("2차: 프로젝트 폴더 안에 새 폴더 → PC의 프로젝트 폴더에 생김", async () => {
    await openConversation(); await createMenu(); await item("프로젝트 폴더 안에 새 폴더…").click();
    const dialog = page.getByRole("dialog", { name: "프로젝트 폴더 안에 새 폴더" });
    await dialog.locator("input").fill("휴대폰 자료"); await dialog.getByRole("button", { name: "폴더 만들기" }).click();
    const ok = await until(async () => existsSync(join(workDir, "휴대폰 자료")), 8000);
    return { ok, detail: `exists=${ok}` };
  }, "9d-directory-390.png");
  await r2("2차: 문서 이름 바꾸기 → 파일 이름이 바뀜", async () => {
    await docMenu("읽기.txt"); await item("이름 바꾸기").click();
    const dialog = page.getByRole("dialog", { name: "문서 이름 바꾸기" });
    await dialog.locator("input").fill("휴대폰에서 바꾼 이름"); await dialog.locator("input").press("Enter");
    const ok = await until(async () => existsSync(join(workDir, "휴대폰에서 바꾼 이름.txt")), 8000);
    return { ok, detail: `renamed=${ok}` };
  }, "9e-doc-rename-390.png");
  await r2("2차: 문서 목록에서 빼기 → 파일은 그대로, 휴지통 항목 없음", async () => {
    await docMenu("안내.html"); await page.waitForTimeout(800);
    const trash = await page.getByRole("menuitem", { name: /휴지통/ }).count();
    await item("목록에서 빼기").click();
    const gone = await until(async () => !(await snapshot()).artifacts.some((entry) => entry.id === documents["안내.html"]), 8000);
    return { ok: gone && existsSync(join(workDir, "안내.html")) && trash === 0, detail: `gone=${gone} file=${existsSync(join(workDir, "안내.html"))} trashItems=${trash}` };
  }, "9f-doc-unlist-390.png");
  await r2("2차: 프로젝트 페이지 → + 결정 → 노트에 남음", async () => {
    await rowMenu("프로젝트", await workTitle()); await item("프로젝트 페이지").click();
    await page.locator("button >> text=+ 결정 >> visible=true").first().click();
    const field = page.locator('[placeholder="정한 것 (Enter)"] >> visible=true').first();
    await field.fill("휴대폰에서 정함: 과제 마감 그대로"); await field.press("Enter");
    const ok = await until(async () => (await api<{ note: { decisions: { text: string }[] } }>("GET", `/api/projects/${work.id}`)).note.decisions.some((entry) => entry.text.includes("휴대폰에서 정함")), 10_000);
    const settings = await page.locator("text=단계 편집 >> visible=true").count();
    return { ok, detail: `decision=${ok} 단계편집보임=${settings}` };
  }, "9g-project-decision-390.png");
  await r2("2차: 문서 불러오기(휴대폰 파일 고르기) → 프로젝트 폴더에 들어감", async () => {
    await rail("프로젝트"); await inList(await workTitle()); await page.waitForTimeout(400);
    const chooser = page.waitForEvent("filechooser", { timeout: 8000 });
    await page.locator('.sidebar button[aria-label="문서 불러오기…"] >> visible=true').first().click({ force: true });
    await (await chooser).setFiles({ name: "휴대폰 자료.pdf", mimeType: "application/pdf", buffer: readFileSync(resolve("scripts/fixtures/opendataloader/text.pdf")) });
    const ok = await until(async () => existsSync(join(workDir, "휴대폰 자료.pdf")), 15_000);
    return { ok, detail: `uploaded=${ok}` };
  }, "9h-upload-390.png");
  await r2("2차: 대화 ⋯ 마크다운으로 내보내기 → 작업 폴더에 저장", async () => {
    const purpose = (await sessionOf(session.id)).purpose;
    await rowMenu("프로젝트", await workTitle()).catch(() => undefined); await page.keyboard.press("Escape");
    await inList(await workTitle()); await page.waitForTimeout(300);
    await page.locator(`.sidebar button[aria-label="${purpose} 더 보기"]`).first().click({ force: true });
    await item("마크다운으로 내보내기").click(); await page.waitForTimeout(300); await item("작업 폴더에 저장").click();
    const ok = await until(async () => (await snapshot()).artifacts.some((entry) => entry.workId === work.id && entry.path.includes("세션 기록")), 10_000);
    return { ok, detail: `saved=${ok}` };
  }, "9i-export-session-390.png");
  await r2("2차: 숨김 — 볼트(레일), 새 웹 탭(새로 만들기), PDF 쪽 편집, 문서 AI 키", async () => {
    await sidebar();
    const vault = await page.locator('.nav-rail button[data-rail="vault"]').count();
    await page.keyboard.press("Escape");
    await createMenu();
    const web = await page.getByRole("menuitem", { name: /웹/ }).count();
    await page.keyboard.press("Escape");
    await openDocument("읽을거리");
    await page.waitForTimeout(2500);
    const pdfEdit = await page.locator("button >> text=오른쪽으로 돌리기").count();
    const pdfLine = await page.locator("text=쪽 돌리기·지우기는 PC에서 합니다 >> visible=true").count();
    const docAi = await page.locator(".doc-agent-toggle").count();
    return { ok: vault === 0 && web === 0 && pdfEdit === 0 && pdfLine > 0 && docAi === 0, detail: JSON.stringify({ vault, web, pdfEdit, pdfLine, docAi }) };
  }, "9j-hidden-390.png");

  // One dark frame: the conversation.
  await page.emulateMedia({ colorScheme: "dark" });
  await openConversation();
  await page.waitForTimeout(1800);
  await shot("7-conversation-dark-390.png");
  // ── 8. the PC's own window: the main screen has no Doory line; the design tab's top line has it (1440×900 light/dark, 390×844) ──
  for (const [width, height, scheme] of [[1440, 900, "light"], [1440, 900, "dark"], [390, 844, "light"]] as const) {
    const pc = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    const desk = await pc.newPage();
    desk.on("pageerror", (error) => errors.push(`PC: ${error.message.slice(0, 200)}`));
    await desk.goto(`${ready.url}/?token=${encodeURIComponent(ready.token)}`);
    await desk.waitForSelector(".topbar", { timeout: 20_000 });
    await desk.waitForTimeout(1500);
    if (scheme === "light" && width === 1440) {
      await desk.screenshot({ path: join(outDir, "8-pc-main-1440-light.png") });
      check("PC 첫 화면(1440): Doory 줄이 앱 화면에 없음", !(await desk.evaluate(() => document.body.innerText)).includes(DOORY));
    }
    if (await desk.getByRole("button", { name: "사이드바 열기" }).count()) await desk.getByRole("button", { name: "사이드바 열기" }).click();
    await desk.locator(".nav-rail >> text=문서 >> visible=true").first().click().catch(() => {});
    await desk.waitForTimeout(600);
    await desk.locator(".sidebar >> text=카드뉴스 >> visible=true").first().click().catch(() => {});
    let line: { top: number; barTop: number; cut: boolean; size: number; color: string; ink: string } | null = null;
    await until(async () => {
      for (const frame of desk.frames()) {
        line = await frame.evaluate(() => {
          const credit = document.querySelector<HTMLElement>(".wb-design-credit"), bar = document.querySelector<HTMLElement>("[data-testid=ed-topbar]");
          if (!credit || !bar || !(credit.textContent ?? "").includes("Creator and maintainer of Doory")) return null;
          return { top: credit.getBoundingClientRect().top, barTop: bar.getBoundingClientRect().top, cut: credit.scrollWidth > credit.clientWidth + 1, size: parseFloat(getComputedStyle(credit).fontSize),
            color: getComputedStyle(credit).color, ink: getComputedStyle(document.body).color };
        }).catch(() => null);
        if (line) return true;
      }
      return false;
    }, 40_000);
    await desk.waitForTimeout(1000);
    await desk.screenshot({ path: join(outDir, `8-pc-design-${width}-${scheme}.png`) });
    const seen = line as { top: number; barTop: number; cut: boolean; size: number; color: string; ink: string } | null;
    check(`PC 디자인 탭(${width}×${height} ${scheme}): 맨 위 줄에 Doory 표시 — 본문 글자색, 12px 이상, 잘리지 않음`, Boolean(seen && seen.top < seen.barTop && !seen.cut && seen.size >= 12 && seen.color === seen.ink), JSON.stringify(seen));
    await pc.close();
  }
  check("휴대폰: 페이지 오류 없음", errors.length === 0, errors.join(" | ") || "없음");
  check("휴대폰: '허용되지 않은 작업' 거절 없음", refusals.length === 0, refusals.join(" | ") || "없음");
  await phone.close();
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

// Transcript A of the design (m02 §6.4/§6.6) WITH the agent browser, on the bundled gateway
// (apps/host/dist/host.mjs), the stand-in Bot API, the stand-in keyring and the stand-in Claude (no
// model), against a loopback test site this script serves on 127.0.0.1 and 127.0.0.2 (two hosts:
// Linux answers the whole 127/8 locally). The agent browser is the real Playwright CLI daemon with a
// real Chromium: this machine has only Playwright's headless shell in its cache, so it stands in for
// the full Chromium the gateway asks for (`channel: "chromium"`) through a link in the smoke's own
// browsers folder; nothing is downloaded. The person gives a login in the chat → the hand-over
// carries a picture of the real login page → the AI's `fill` makes the gateway type the stored values
// → its next snapshot shows no value → a second factor (a code) is typed by the gateway → the site
// says "내 서재". Then the refusals (another host, a visible field, a frame of another site, a page
// that moved to another host), a short password, a sampling of every process's command line during
// the fills, and a search of every byte of the data folder (the browser profile and its output
// included), the daemon's folder and everything sent to the stand-in Telegram. Values are random and
// never printed.
//
// Usage (through ux/run-isolated.sh): node scripts/login-smoke.ts   (build the host bundle first)

import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ChannelsState, Snapshot, TranscriptItem } from "@workbench/contracts";
import { FAKE_TOKEN, FakeTelegram } from "../apps/host/src/channels/fake-telegram.ts";
import { formsOf } from "../apps/host/src/credentials/forms.ts";

const ID = `zz-user-${randomBytes(6).toString("hex")}`;
const PASSWORD = `zz-secret-${randomBytes(9).toString("base64url")}`;
const SHORT = `zz${randomBytes(3).toString("hex").slice(0, 4)}`; // 6 characters: under the scrubber's 8
const CODE = String(randomInt(100000, 999999));
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const wait = async (what: string, test: () => boolean | Promise<boolean>, ms = 60_000) => {
  const start = Date.now();
  while (!(await test())) {
    if (Date.now() - start > ms) { check(false, `${what} (timed out)`); return false; }
    await sleep(100);
  }
  return true;
};

const root = mkdtempSync(join(tmpdir(), "workbench-login-smoke-"));
const dataDir = join(root, "data");
const daemonDir = join(root, "daemon");
mkdirSync(dataDir, { recursive: true });

// The headless shell of the Playwright cache, linked where the gateway's CLI looks for Chromium.
const shell = join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache", "ms-playwright"), "chromium_headless_shell-1248", "chrome-headless-shell-linux64", "chrome-headless-shell");
if (!existsSync(shell)) { console.log(`FAIL no headless shell at ${shell}: not run`); process.exit(2); }
const fullChrome = join(dataDir, "agent-browser", "browsers", "chromium-1248", "chrome-linux64");
mkdirSync(fullChrome, { recursive: true });
symlinkSync(shell, join(fullChrome, "chrome"));
const cli = resolve("node_modules/playwright-core/lib/tools/cli-client/cli.js");

// The loopback test site: what each host received (the site itself may get the login: that is the point).
const got: { host: string; path: string; body: string }[] = [];
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const loginForm = (action: string, passwordType = "password") => `<form action="${action}" method="post"><label>아이디 <input name="u"></label><label>비밀번호 <input name="p" type="${passwordType}"></label><button>로그인</button></form>`;
let port = 0;
const site = (host: string) => createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const path = (req.url ?? "/").split("?")[0]!;
    got.push({ host, path, body });
    const form = new URLSearchParams(body);
    const send = (html: string) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html); };
    const go = (to: string) => { res.statusCode = 302; res.setHeader("location", to); res.end(); };
    if (path === "/login") return send(page("도서관 로그인", loginForm("/check")));
    if (path === "/login2") return send(page("도서관 로그인", loginForm("/check2")));
    if (path === "/check") return form.get("u") === ID && form.get("p") === PASSWORD ? go("/otp") : send(page("도서관 로그인", `<p>틀렸습니다</p>${loginForm("/check")}`));
    if (path === "/otp") return send(page("인증", `<form action="/otp-check" method="post"><label>인증번호 <input name="c" inputmode="numeric"></label><button>확인</button></form>`));
    if (path === "/otp-check") return form.get("c") === CODE ? go("/done") : send(page("인증", "<p>틀렸습니다</p>"));
    if (path === "/done") return send(page("내 서재", "<p>대출 7권</p>"));
    if (path === "/visible") return send(page("도서관 로그인", loginForm("/check", "text")));
    if (path === "/framed") return send(page("도서관", `<iframe src="http://127.0.0.2:${port}/login" width="600" height="300"></iframe>`));
    if (path === "/bounce") return send(page("도서관 로그인", `${loginForm("/check")}<script>setTimeout(() => { location.href = "http://127.0.0.2:${port}/login"; }, 1500)</script>`));
    res.statusCode = 404; res.end();
  });
});
const servers: Server[] = [site("127.0.0.1"), site("127.0.0.2")];
await new Promise<void>((done) => servers[0]!.listen(0, "127.0.0.1", done));
port = (servers[0]!.address() as { port: number }).port;
await new Promise<void>((done) => servers[1]!.listen(port, "127.0.0.2", done));
const SITE = `http://127.0.0.1:${port}`;

// Every process's command line, sampled while the gateway runs.
const values = [PASSWORD, SHORT, CODE];
/** Every form a value is searched in: the scrubber's forms, and a value under its 8 characters as typed (and URL-encoded). */
const formsFor = (value: string) => (value.length < 8 ? [...new Set([value, encodeURIComponent(value)])] : formsOf(value));
const seenInArgv = new Set<string>();
let samples = 0;
const sampler = setInterval(() => {
  samples += 1;
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const line = readFileSync(`/proc/${pid}/cmdline`, "latin1");
      for (const value of values) if (formsFor(value).some((form) => line.includes(form))) seenInArgv.add(value === PASSWORD ? "password" : value === SHORT ? "short" : "code");
    } catch { /* Gone, or another user's. */ }
  }
}, 15);

const fake = new FakeTelegram();
await fake.start();
const output: string[] = [];
const child = spawn(process.execPath, [process.env.SMOKE_HOST_ENTRY ?? "apps/host/dist/host.mjs"], {
  env: {
    ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_TELEGRAM_API: fake.url, WORKBENCH_SECRET_BIN: resolve("scripts/fixtures/fake-secret.mjs"),
    WORKBENCH_BROWSER_CLI: cli, WORKBENCH_BROWSER_HEADLESS: "1",
    // The CLI's daemons register here, never in the owner's cache.
    PWTEST_DAEMON_SESSION_DIR: daemonDir, XDG_CACHE_HOME: join(root, "cache"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr!.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
process.on("exit", () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });

/** Our own processes still running: those whose command line names this smoke's folder. */
const ours = () => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid) && Number(pid) !== process.pid).filter((pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(root); } catch { return false; } }).map(Number);

let gatewayExited = false;
try {
  const ready = await new Promise<{ url: string; token: string }>((done, reject) => {
    child.once("exit", (code) => reject(new Error(`gateway exited before readiness (${code})`)));
    createInterface({ input: child.stdout! }).on("line", (line) => { output.push(line); if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16))); });
  });
  console.log(`gateway pid ${child.pid} · site ${SITE} and http://127.0.0.2:${port} · browser: Playwright chromium_headless_shell-1248 (standing in for Chrome for Testing)`);
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    output.push(text);
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return JSON.parse(text) as T;
  };
  const deleted = (update: Record<string, unknown>) => fake.of("deleteMessage").filter((call) => call.params.message_id === (update.message as { message_id: number }).message_id).length;

  await api("POST", "/api/channels/telegram/bots", { token: FAKE_TOKEN });
  const { link } = await api<{ link: string }>("POST", `/api/channels/telegram/bots/${fake.botId}/pairing`, {});
  fake.message(`/start ${new URL(link).searchParams.get("start")}`);
  await wait("pairing request", async () => Boolean((await api<ChannelsState>("GET", "/api/channels")).bots[0]?.pairing.request));
  const request = (await api<ChannelsState>("GET", "/api/channels")).bots[0]!.pairing.request!;
  await api("POST", `/api/channels/telegram/bots/${fake.botId}/pairing/${request.id}`, { approve: true });

  let sessionId = "";
  const items = async () => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${sessionId}/items`)).items;
  const answers = async () => (await items()).filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : ""));
  /** One request from the phone, and the stand-in AI's whole turn. */
  const turn = async (text: string, what: string) => {
    // The conversation is idle first: a line sent into a running turn would join it.
    if (sessionId) await wait(`idle before: ${what}`, async () => (await api<Snapshot>("GET", "/api/snapshot")).sessions.find((session) => session.id === sessionId)?.status === "idle", 90_000);
    const before = sessionId ? (await items()).filter((item) => item.kind === "turnEnd").length : 0;
    fake.message(text);
    if (!sessionId) {
      await wait("the conversation starts", async () => Boolean((await api<Snapshot>("GET", "/api/snapshot")).sessions.find((session) => session.purpose.startsWith("휴대폰"))));
      sessionId = (await api<Snapshot>("GET", "/api/snapshot")).sessions.find((session) => session.purpose.startsWith("휴대폰"))!.id;
    }
    // Its own turn: the turn end after the user item that carries this text.
    const mark = text.split("\n")[0]!.slice(0, 40);
    await wait(what, async () => {
      const list = await items();
      const asked = list.findLastIndex((item) => item.kind === "user" && item.text.includes(mark));
      return asked >= 0 && list.slice(asked).some((item) => item.kind === "turnEnd") && list.filter((item) => item.kind === "turnEnd").length > before;
    }, 90_000);
    const answer = (await answers()).at(-1) ?? "";
    if (process.env.SMOKE_DEBUG) {
      const mask = (text: string) => values.reduce((out, value) => out.split(value).join("<VALUE>"), text);
      const tools = (await items()).filter((item) => item.kind === "tool").slice(-3).map((item) => (item.kind === "tool" ? `[${item.title} | ${item.detail ?? ""}]\n${item.output ?? ""}` : ""));
      console.log(`DEBUG site got: ${got.map((entry) => `${entry.host}${entry.path}`).join(" ")}`);
      console.log(`DEBUG ${what}\n${mask(answer).split("\n").slice(0, 2).join(" / ")}\n${tools.map((text) => mask(text).slice(0, 1500)).join("\n---\n")}`);
    }
    return answer;
  };
  /** The refs of the agent page's latest snapshot file (as the AI reads them). */
  const refs = async () => {
    // The last browser answer: its snapshot inline, or in the file it links.
    const last = (await items()).filter((item) => item.kind === "tool" && /Snapshot/.test(item.output ?? "")).at(-1);
    const out = last?.kind === "tool" ? last.output ?? "" : "";
    const file = /\[Snapshot\]\(([^)]+)\)/.exec(out)?.[1];
    let text = out;
    try { if (file) text = readFileSync(file.startsWith("/") ? file : join(dataDir, "agent-browser", "output", file.split("/").at(-1)!), "utf8"); } catch { /* Inline. */ }
    const ref = (pattern: RegExp) => pattern.exec(text)?.[1] ?? "e0";
    return { id: ref(/textbox "아이디"[^\n]*?\[ref=(f?\d*e\d+)\]/), pw: ref(/textbox "비밀번호"[^\n]*?\[ref=(f?\d*e\d+)\]/), submit: ref(/button "로그인"[^\n]*?\[ref=(f?\d*e\d+)\]/), code: ref(/textbox "인증번호"[^\n]*?\[ref=(f?\d*e\d+)\]/), ok: ref(/button "확인"[^\n]*?\[ref=(f?\d*e\d+)\]/), text };
  };
  const toolOutputs = async () => JSON.stringify((await items()).filter((item) => item.kind === "tool"));

  // 1. A first login: the AI opens the site and asks; the hand-over carries the real page's picture.
  const opened = await turn(`브라우저 ${SITE}/login 비밀 필요: need --name 도서관 --kind login --site ${SITE} --fields 아이디,비밀번호`, "the AI opens the login page and asks");
  check(opened.includes("제목: 도서관 로그인") && opened.includes("workbench-credential: fail:handover_sent"), "the AI opened the real login page in Chromium and got fail:handover_sent");
  await wait("the hand-over message", () => fake.texts().some((text) => text.includes("'도서관' 로그인 정보가 필요합니다")));
  const photo = fake.of("sendPhoto")[0];
  const ask = fake.of("sendMessage").find((call) => String(call.params.text).includes("'도서관' 로그인 정보가 필요합니다"))!;
  check(Boolean(photo) && fake.calls.indexOf(photo!) < fake.calls.indexOf(ask), "a picture of the login page went as its own message before the hand-over");
  check(photo?.file?.name === "login.png" && (photo.file.head ?? "").startsWith("89504e47") && photo.file.bytes > 1000, `the picture is a real PNG of the page named login.png (${photo?.file?.bytes ?? 0} bytes)`);
  check(Boolean(fake.buttonData("나중에")), "the hand-over's own button is on its text message");
  check(readdirSync(join(dataDir, "credential-tool", "pictures")).length === 0, "the picture file is gone once sent");
  const one = fake.message(ID);
  await wait("아이디 taken and deleted", () => deleted(one) === 1 && fake.texts().some((text) => text.startsWith("'도서관'의 아이디를 받았습니다")));
  const two = fake.message(PASSWORD);
  await wait("비밀번호 taken and deleted", () => deleted(two) === 1);
  await wait("the continuation's turn: need answers ok", async () => (await answers()).some((text) => text.includes("workbench-credential: ok")), 90_000);

  // 2. The AI points, the gateway types (no submit first), and its next snapshot shows no value.
  let r = await refs();
  check(r.pw !== "e0" && r.id !== "e0", `refs from the AI's snapshot: 아이디=${r.id} 비밀번호=${r.pw} 로그인=${r.submit}`);
  const filled = await turn(`비밀 필요: fill --name 도서관 --ref 아이디=${r.id} --ref 비밀번호=${r.pw}\n화면 명령: snapshot`, "fill, then a snapshot");
  check(filled.includes("workbench-credential: ok"), "fill: ok");
  const shown = await toolOutputs();
  check(shown.includes("[비밀: 도서관]") && !formsOf(PASSWORD).some((form) => shown.includes(form)), "the AI's next snapshot shows the password field as [비밀: 도서관], never the value");
  check(!formsOf(PASSWORD).some((form) => readdirSync(join(dataDir, "agent-browser", "output")).some((name) => readFileSync(join(dataDir, "agent-browser", "output", name)).includes(form))), "no snapshot file holds the value");
  check(fake.texts().every((text) => !text.includes("제목: 인증")), "the chat heard nothing of the fill");
  r = await refs();
  const submitted = await turn(`비밀 필요: fill --name 도서관 --ref 아이디=${r.id} --ref 비밀번호=${r.pw} --submit ${r.submit}\n화면 명령: snapshot`, "fill and submit");
  check(submitted.includes("workbench-credential: ok") && got.some((entry) => entry.host === "127.0.0.1" && entry.path === "/check" && new URLSearchParams(entry.body).get("p") === PASSWORD), "fill with submit: the site got the login and moved to its code page");

  // 3. A second factor: a code, given in the chat, typed by the gateway.
  r = await refs();
  const stepped = await turn(`비밀 필요: step --name 도서관 --kind code --ref ${r.code} --submit ${r.ok} --label "문자 인증번호"`, "the AI asks for the code");
  check(stepped.includes("workbench-credential: fail:handover_sent"), "step: fail:handover_sent");
  await wait("the code message", () => fake.texts().some((text) => text.includes("문자 인증번호를 묻습니다")));
  check(fake.of("sendPhoto").length === 2, "with a picture of the code page");
  const code = fake.message(CODE);
  await wait("the code is taken, deleted and typed; the site says 내 서재", () => deleted(code) === 1 && got.some((entry) => entry.path === "/done"), 30_000);
  await wait("one continuation", async () => (await items()).some((item) => item.kind === "user" && item.text.includes("문자 인증번호를 넣었습니다")), 30_000);
  const after = await turn("화면 명령: snapshot", "a snapshot after the code");
  void after;
  check((await toolOutputs()).includes("내 서재"), "the AI's next page is 내 서재");

  // 4. A short password (6 characters, under the scrubber's 8): hidden by the window's own rule.
  await api("POST", "/api/channels/credentials", { name: "짧은", kind: "login", site: SITE, values: { 아이디: ID, 비밀번호: SHORT } });
  await turn(`브라우저 ${SITE}/login2`, "open the second login page");
  r = await refs();
  await turn(`비밀 필요: fill --name 짧은 --ref 아이디=${r.id} --ref 비밀번호=${r.pw}\n화면 명령: snapshot`, "fill a short password, then a snapshot");
  const shortShown = await toolOutputs();
  check(shortShown.includes("[비밀: 짧은]") && !shortShown.includes(SHORT), "a 6-character password never shows in the AI's next snapshot");

  // A page (or a prompt-injected AI) shows the password as text: an eval reading it is hidden; a picture is refused.
  await turn(`화면 명령: eval "() => document.querySelector('input[name=p]').value"`, "the AI reads the field's value");
  check(!(await toolOutputs()).includes(SHORT), "an eval that reads the password field's value gets it hidden");
  await turn(`화면 명령: eval "() => { document.querySelector('input[name=p]').type = 'text'; return 'shown'; }"`, "the AI turns the field into text");
  await turn("화면 명령: screenshot", "the AI takes a screenshot");
  check((await toolOutputs()).includes("찍지 않았습니다"), "a screenshot while the password shows as text is refused");

  // 5. Refusals.
  await turn(`브라우저 http://127.0.0.2:${port}/login`, "open another host");
  r = await refs();
  const wrong = await turn(`비밀 필요: fill --name 도서관 --ref 아이디=${r.id} --ref 비밀번호=${r.pw} --submit ${r.submit}`, "fill on another host");
  check(wrong.includes("fail:wrong_site") && !got.some((entry) => entry.host === "127.0.0.2" && entry.path === "/check"), "another host (127.0.0.2): fail:wrong_site, nothing sent there");
  await wait("the chat is told once", () => fake.texts().filter((text) => text.includes("저장한 사이트에서만 넣습니다")).length === 1);
  await turn(`브라우저 ${SITE}/visible`, "open a page with a visible password field");
  r = await refs();
  check((await turn(`비밀 필요: fill --name 도서관 --ref 아이디=${r.id} --ref 비밀번호=${r.pw}`, "fill a visible field")).includes("fail:visible_field"), "a password field that shows its text: fail:visible_field");
  await turn(`브라우저 ${SITE}/framed`, "open a page framing another host's login");
  r = await refs();
  check(r.pw.startsWith("f") && (await turn(`비밀 필요: fill --name 도서관 --ref 비밀번호=${r.pw}`, "fill inside a frame of another host")).includes("fail:wrong_site"), `a frame from another host (${r.pw}): fail:wrong_site`);
  await turn(`브라우저 ${SITE}/bounce`, "open a page that moves to another host");
  r = await refs();
  await sleep(2500);
  const bounced = await turn(`비밀 필요: fill --name 도서관 --ref 아이디=${r.id} --ref 비밀번호=${r.pw} --submit ${r.submit}`, "fill after the page moved");
  check((bounced.includes("fail:wrong_site") || bounced.includes("fail:stale_ref")) && !got.some((entry) => entry.host === "127.0.0.2" && entry.path === "/check"), `a page that moved to another host between snapshot and fill: ${/fail:[a-z_]+/.exec(bounced)?.[0] ?? "?"}`);

  // 6. Close: the gateway closes its window.
  child.kill("SIGTERM");
  await new Promise<void>((done) => (child.exitCode !== null ? done() : child.once("exit", () => done())));
  gatewayExited = true;
} catch (error) {
  check(false, `smoke stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  clearInterval(sampler);
  if (!gatewayExited && child.exitCode === null) { child.kill("SIGTERM"); await sleep(3000); }
  await sleep(1000);
  const left = ours();
  check(left.length === 0, `no process of this smoke is left (${left.length})`);
  for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ } }
  for (const server of servers) server.close();
  await fake.stop();
}

check(samples > 50 && seenInArgv.size === 0, `no value in any process's command line (${samples} samples of /proc/*/cmdline)`);
const sent = JSON.stringify(fake.calls);
for (const [label, value] of [["password", PASSWORD], ["short", SHORT], ["code", CODE]] as const) check(!formsFor(value).some((form) => sent.includes(form)), `nothing sent to the messenger carries the ${label}`);
/** Every byte under a folder: where a value's forms are. */
function search(folder: string, value: string): string[] {
  const hits: string[] = [];
  if (!existsSync(folder)) return hits;
  for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    let bytes: Buffer;
    try { bytes = readFileSync(path); } catch { continue; }
    const text = bytes.toString("latin1") + bytes.toString("utf8");
    if (formsFor(value).some((form) => text.includes(form))) hits.push(path.slice(root.length));
  }
  return hits;
}
for (const [label, value] of [["password", PASSWORD], ["short", SHORT], ["code", CODE]] as const) {
  const hits = [...search(dataDir, value), ...search(daemonDir, value), ...search(join(root, "cache"), value)];
  check(hits.length === 0, `the ${label} is nowhere in the data folder (profile and browser output included), the daemon's folder or the cache: ${hits.join(" ") || "none"}`);
}
const idHits = search(dataDir, ID);
console.log(`INFO the 아이디 (not secret, R2) appears in: ${idHits.join(" ") || "nowhere"}`);
writeFileSync(join(dataDir, "planted"), Buffer.from(PASSWORD).toString("base64"));
check(search(dataDir, PASSWORD).length > 0, "the search finds a planted value");
writeFileSync(join(dataDir, "planted-short"), `x${SHORT}y ${CODE}`);
check(search(dataDir, SHORT).length > 0 && search(dataDir, CODE).length > 0, "the search finds a planted short password and a planted code (values under 8 characters are searched as typed)");
const log = output.join("\n");
check(!values.some((value) => formsFor(value).some((form) => log.includes(form))), "the gateway's output and HTTP answers carry no value");
rmSync(root, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} FAILED` : "\nALL PASSED");
process.exit(failures.length ? 1 : 0);

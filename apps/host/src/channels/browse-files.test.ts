import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { browserSessionName, type Session, type Work } from "@workbench/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBrowser } from "../browse.ts";
import { CredentialService } from "../credentials/service.ts";
import { installScrubber } from "../credentials/install.ts";
import { OfficeVault } from "../office-vault.ts";
import { cleanKits, pair, say, settle, startKit, type Kit } from "./test-kit.ts";

// Round 3, ruling C, through ChannelCore: "이 페이지 캡처해서 보내 줘" from the phone. The AI runs the
// browser CLI (the stand-in on 127.0.0.1-free pipes) with a file name in its work folder; the
// picture arrives there hidden, the answer names it, and the chat receives it. While a typed value
// is live on a page part that cannot be read, the picture is still withheld with its sentence.

const FAKE_CLI = resolve("scripts/fixtures/fake-playwright-cli.mjs");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
const browsers: AgentBrowser[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
const saved = process.env.PWTEST_DAEMON_SESSION_DIR;
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.shutdown();
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.PWTEST_DAEMON_SESSION_DIR; else process.env.PWTEST_DAEMON_SESSION_DIR = saved;
  cleanKits();
});

async function rig() {
  const kit = await startKit();
  const vault = new OfficeVault(kit.dataDir, async () => ({ id: "c".repeat(32), key: Buffer.alloc(32, 7) }));
  const service = new CredentialService({ dataDir: kit.dataDir, vault, manager: kit.manager, now: () => kit.clock.now });
  installScrubber(kit.store, kit.manager, service.scrubber);
  await service.add({ name: "포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: "zz-fake-user", 비밀번호: "zz-fake-pass-0909" } });
  await pair(kit);
  await say(kit, "이 페이지 캡처해서 보내 줘");
  const { sessionId } = kit.engine.sent.at(-1)!;
  const session = kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!;
  const cwd = kit.manager.workCwd(session.workId);
  const browserData = mkdtempSync(join(tmpdir(), "wb-browse-chat-"));
  dirs.push(browserData);
  process.env.FAKE_PWCLI_DIR = join(browserData, "fake");
  mkdirSync(process.env.FAKE_PWCLI_DIR, { recursive: true });
  const browser = new AgentBrowser({ dataDir: browserData, cli: FAKE_CLI, idleCloseMs: 60_000 });
  browsers.push(browser);
  browser.scrubOutput = (text) => service.scrubber.text(text);
  browser.storedNeedles = () => service.scrubber.needles();
  browser.storedExact = (text) => service.scrubber.exact(text);
  const shown = { ...session, browser: true, status: "running" } as Session;
  browser.bind({
    lookup: (id) => (id === sessionId ? { session: shown, work: { id: session.workId, cwd } as Work, access: "full" } : null),
    sessions: () => [shown],
    upsertItem: () => undefined,
    updateSession: () => undefined,
    publish: () => undefined,
  });
  const name = browserSessionName(sessionId);
  const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn("playwright-cli", [`-s=${name}`, ...args], { cwd, env: { ...process.env, PATH: `${browser.paths.bin}${delimiter}${process.env.PATH}` } });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("exit", (code) => done({ code, out }));
  });
  expect((await cli(["open", "https://example.com"])).code).toBe(0);
  writeFileSync(join(process.env.FAKE_PWCLI_DIR, "screenshot.bin"), PNG);
  return { kit, browser, sessionId, cwd, cli, name };
}

/** The AI ends its turn naming the file, as the phone preamble asks. */
async function answer(kit: Kit, sessionId: string, text: string) {
  kit.engine.say(sessionId, text);
  kit.engine.finish(sessionId);
  await settle(kit);
  return kit.adapter.last()!;
}

describe("round 3, ruling C: a picture the AI saves reaches the phone", () => {
  it("screenshot --filename shot.png: the picture is in the work folder, the answer names it, and the chat receives it", async () => {
    const { kit, sessionId, cli } = await rig();
    const shot = await cli(["screenshot", "--filename", "shot.png"]);
    expect(shot.code).toBe(0);
    expect(shot.out).toContain("shot.png에 두었습니다");
    await answer(kit, sessionId, "캡처했습니다.\n파일: shot.png");
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["shot.png"]);
    expect(kit.adapter.uploads[0]!.bytes.equals(PNG)).toBe(true);
  }, 60_000);

  it("with a typed value live on a page part that cannot be read, the picture is withheld with its sentence and nothing reaches the chat", async () => {
    const { kit, browser, sessionId, cli, name } = await rig();
    // The window's daemon answers the page check: a frame the check cannot read (I9).
    const root = mkdtempSync(join(tmpdir(), "wb-daemon-"));
    dirs.push(root);
    process.env.PWTEST_DAEMON_SESSION_DIR = join(root, "daemon");
    mkdirSync(join(root, "daemon", "0123456789abcdef"), { recursive: true });
    const socketDir = join(browser.socketsDir, "cli");
    mkdirSync(socketDir, { recursive: true });
    const socketPath = join(socketDir, `${name}.sock`);
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const message = JSON.parse(buffer.slice(0, end)) as { id: number };
        socket.write(`${JSON.stringify({ id: message.id, result: { text: JSON.stringify(JSON.stringify({ values: [], text: "로그인", blind: 1 })) } })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(socketPath, done));
    writeFileSync(join(root, "daemon", "0123456789abcdef", `${name}.session`), JSON.stringify({ name, version: "0.1.22", socketPath, browser: { userDataDir: browser.paths.profile } }));
    const page = browser.hostPage(sessionId);
    if (typeof page === "string") throw new Error(page);
    page.typed("포털", ["zz7f09"]);
    const shot = await cli(["screenshot", "--filename", "shot.png"]);
    expect(shot.code).not.toBe(0);
    expect(shot.out).toContain("찍지 않았습니다");
    await answer(kit, sessionId, "화면에 비밀 값이 보일 수 있어 캡처하지 않았습니다.\n파일: shot.png");
    expect(kit.adapter.uploads).toEqual([]);
  }, 60_000);
});

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessMode, ProviderStatus, Session, TranscriptItem, Work } from "@workbench/contracts";
import { GeminiAdapter, GEMINI_CLIENT_NAME, GEMINI_SUSPENDED, type GeminiSettings } from "./gemini.ts";
import { AGY_RECOMMENDED_VERSION, agyEnv, agyVersionOk, strippedAgyVars } from "./gemini-locate.ts";
import { suspensionOf, diffText, effectiveAccess, mapToolCall, modeFor, modelsFromConfig, permissionOption } from "./gemini-map.ts";
import type { AdapterSink } from "./types.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FAKE = join(repo, "scripts/fixtures/fake-agy.mjs");
// 1x1 PNG
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

type Log = { event: string; method?: string; params?: Record<string, unknown>; argv?: string[]; googleVars?: string[]; answer?: { outcome?: { outcome?: string; optionId?: string } }; text?: string; images?: { bytes: number }[] };

let dir: string;
let items: Map<string, TranscriptItem[]>;
let sessions: Map<string, Partial<Session>>;
let statuses: ProviderStatus[];
let dropped: string[][];
let spawned: { args: string[]; env: NodeJS.ProcessEnv }[];
let adapters: GeminiAdapter[];

const sink = (): AdapterSink => ({
  upsertItem: (id, item) => {
    const list = items.get(id) ?? [];
    const index = list.findIndex((entry) => entry.id === item.id);
    if (index >= 0) list[index] = item; else list.push(item);
    items.set(id, list);
  },
  delta: (id, itemId, text) => {
    const entry = items.get(id)?.find((item) => item.id === itemId);
    if (entry && (entry.kind === "assistant" || entry.kind === "reasoning")) entry.text += text;
  },
  updateSession: (id, patch) => sessions.set(id, { ...sessions.get(id), ...patch }),
  providerStatus: (status) => statuses.push(status),
  steerDropped: (_id, keys) => dropped.push(keys),
  toolImages: () => undefined,
});

const log = (): Log[] => (existsSync(join(dir, "agy.log")) ? readFileSync(join(dir, "agy.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Log) : []);
const until = async (check: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((done) => setTimeout(done, 25)); }
  return check();
};
const work = (): Work => ({ id: "w1", title: "W", titleSource: "user", folderId: null, cwd: join(dir, "project"), cwdManaged: false, activeSessionId: null, pinned: false, sort: 0, archivedAt: null, createdAt: 0, updatedAt: 0 });
const session = (over: Partial<Session> = {}): Session & { access: AccessMode } => ({
  id: "s1", workId: "w1", provider: "gemini", hostId: "h", nativeSessionId: null, purpose: "대화", purposeSource: "auto", model: null, effort: null, engineModel: null, engineEffort: null,
  preview: null, previewAt: null, status: "idle", activity: null, lastError: null, pinned: false, sort: 0, archivedAt: null, seenAt: null, unread: false, queued: [], context: null,
  createdAt: 0, updatedAt: 0, ...over, access: (over.access ?? "ask") as AccessMode,
});
const ended = (id = "s1") => (items.get(id) ?? []).filter((item) => item.kind === "turnEnd");

function make(settings: Partial<GeminiSettings> = {}, env: NodeJS.ProcessEnv = {}, extra: Partial<ConstructorParameters<typeof GeminiAdapter>[1]> = {}) {
  const full: GeminiSettings = { googleOptIn: true, ...settings };
  const adapter = new GeminiAdapter(sink(), {
    settings: () => full,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WORKBENCH_AGY_BIN: FAKE, FAKE_AGY_LOG: join(dir, "agy.log"), FAKE_AGY_STATE: join(dir, "state"), ...env },
    spawn: (command, args, options) => { spawned.push({ args, env: options.env ?? {} }); return spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }); },
    mcpServers: () => [{ name: "workbench-tools", command: process.execPath, args: ["--version"], env: [] }],
    idleMs: 60_000,
    probeTimeoutMs: 20_000,
    ...extra,
  });
  adapters.push(adapter);
  return adapter;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-gemini-"));
  mkdirSync(join(dir, "project"), { recursive: true });
  items = new Map(); sessions = new Map(); statuses = []; dropped = []; spawned = []; adapters = [];
});
afterEach(async () => {
  for (const adapter of adapters) await adapter.shutdown();
  await new Promise((done) => setTimeout(done, 100));
  rmSync(dir, { recursive: true, force: true });
});

describe("Gemini ACP client — pure mapping", () => {
  it("maps access to agy modes and never to a skip-permissions mode", () => {
    const modes = ["default", "accept-edits", "plan"];
    expect(modeFor("ask", false, modes)).toBe("default");
    expect(modeFor("auto", false, modes)).toBe("accept-edits");
    expect(modeFor("full", false, modes)).toBe("accept-edits");
    expect(modeFor("auto", true, modes)).toBe("plan");
  });
  it("permission mapping: no 전체 접근 for Gemini; accept is allow once", () => {
    expect(effectiveAccess("full")).toBe("auto");
    const options = [{ optionId: "a1", name: "Allow once", kind: "allow_once" }, { optionId: "a2", name: "Always", kind: "allow_always" }, { optionId: "r1", name: "Reject", kind: "reject_once" }];
    expect(permissionOption(options, "accept")).toBe("a1");
    expect(permissionOption(options, "decline")).toBe("r1");
  });
  it("draws edits as file changes with their diff, reads and commands like the other engines", () => {
    const edit = mapToolCall({ toolCallId: "t", kind: "edit", status: "completed", content: [{ type: "diff", path: "/p/a.md", oldText: "x\n", newText: "x\ny\n" }] }, "/p", 1);
    expect(edit).toMatchObject({ tool: "fileChange", status: "completed", paths: ["/p/a.md"], title: "/p/a.md" });
    expect(edit.output).toContain("+y");
    expect(mapToolCall({ toolCallId: "r", kind: "read", status: "completed", locations: [{ path: "b.md" }] }, "/p", 1)).toMatchObject({ tool: "search", reads: ["/p/b.md"] });
    expect(mapToolCall({ toolCallId: "c", kind: "execute", status: "pending", rawInput: { command: "ls" } }, "/p", 1)).toMatchObject({ tool: "command", title: "ls", status: "running" });
    expect(diffText({ path: "/p/n", oldText: null, newText: "a" })).toContain("--- /dev/null");
  });
  it("fills the model picker from the session's selectors, nothing hard-coded", () => {
    const models = modelsFromConfig([
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "m2", options: [{ value: "m1", name: "One" }, { value: "m2", name: "Two" }] },
      { id: "t", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    ]);
    expect(models).toEqual([
      { id: "m1", label: "One", description: null, efforts: ["low", "high"], defaultEffort: "high", isDefault: false },
      { id: "m2", label: "Two", description: null, efforts: ["low", "high"], defaultEffort: "high", isDefault: true },
    ]);
  });
  it("1.5.12 or later is recommended (1.5.2 stays the minimum)", () => {
    expect(agyVersionOk("1.5.11", AGY_RECOMMENDED_VERSION)).toBe(false);
    expect(agyVersionOk("1.5.12", AGY_RECOMMENDED_VERSION)).toBe(true);
    expect(agyVersionOk("1.5.5")).toBe(true);
  });
  it("version gate ≥ 1.5.2", () => {
    expect(agyVersionOk("1.5.13")).toBe(true);
    expect(agyVersionOk("1.5.2")).toBe(true);
    expect(agyVersionOk("1.5.1")).toBe(false);
    expect(agyVersionOk("1.4.9")).toBe(false);
    expect(agyVersionOk(null)).toBe(false);
  });
  it("environment hygiene: agy gets no inherited key, Cloud project or Vertex variable", () => {
    const base = { PATH: "/bin", GEMINI_API_KEY: "inherited", GOOGLE_API_KEY: "inherited", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_APPLICATION_CREDENTIALS: "/c", GOOGLE_GENAI_USE_VERTEXAI: "1", ANTHROPIC_API_KEY: "a", WORKBENCH_TOKEN: "t" };
    const env = agyEnv({ base, os: "linux" });
    for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI", "ANTHROPIC_API_KEY", "WORKBENCH_TOKEN"]) expect(env[name]).toBeUndefined();
    expect(strippedAgyVars(base, "linux").sort()).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI"]);
  });
});

describe("Gemini ACP client — against the stand-in agy", () => {
  it("handshake: launches `agy acp --disable-telemetry`, names itself achmage-workbench, opens the session in the project folder with Workbench's MCP servers", async () => {
    const adapter = make();
    await adapter.send(session(), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    const start = log().find((entry) => entry.event === "start" && entry.argv?.[0] === "acp" && !entry.argv.includes("--login"));
    expect(start?.argv).toEqual(["acp", "--disable-telemetry"]);
    const init = log().find((entry) => entry.method === "initialize");
    expect((init?.params?.clientInfo as { name: string }).name).toBe(GEMINI_CLIENT_NAME);
    expect(init?.params?.protocolVersion).toBe(1);
    const opened = log().find((entry) => entry.method === "session/new");
    expect(opened?.params?.cwd).toBe(work().cwd);
    expect((opened?.params?.mcpServers as { name: string }[]).map((server) => server.name)).toEqual(["workbench-tools"]);
    const answer = items.get("s1")!.find((item) => item.kind === "assistant");
    expect(answer && answer.kind === "assistant" && answer.text).toContain("Gemini 대역 답입니다");
    expect(ended()[0]).toMatchObject({ status: "completed", requestId: "k1" });
    expect(sessions.get("s1")?.nativeSessionId).toMatch(/^standin-/);
    expect(sessions.get("s1")?.context?.window).toBe(1_000_000);
    expect(adapter.status().models.map((model) => model.id)).toEqual(["standin-pro", "standin-flash"]);
  }, 60_000);

  it("묻기: a file edit asks with an approval card; accepted, it becomes a completed file change with its diff", async () => {
    const adapter = make();
    await adapter.send(session(), work(), "파일 고쳐 줘", "k1");
    expect(await until(() => (items.get("s1") ?? []).some((item) => item.kind === "approval"))).toBe(true);
    const card = items.get("s1")!.find((item) => item.kind === "approval")!;
    expect(card).toMatchObject({ title: "파일을 변경할까요?", decision: null });
    expect(sessions.get("s1")?.status).toBe("awaitingApproval");
    expect(await adapter.answerApproval(session(), card.id, "accept")).toBe(true);
    expect(await until(() => ended().length === 1)).toBe(true);
    expect(log().find((entry) => entry.event === "permission-answer")?.answer?.outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    const change = items.get("s1")!.find((item) => item.kind === "tool" && item.tool === "fileChange");
    expect(change).toMatchObject({ status: "completed", paths: [join(work().cwd, "notes.md")] });
    expect(change?.kind === "tool" && change.output).toContain("+Gemini 대역이 고친 줄입니다.");
    expect(readFileSync(join(work().cwd, "notes.md"), "utf8")).toContain("Gemini 대역");
  }, 60_000);

  it("전체 is treated as 자동 (accept-edits) and a command still asks", async () => {
    const adapter = make();
    await adapter.send(session({ access: "full" }), work(), "명령 실행", "k1");
    expect(await until(() => (items.get("s1") ?? []).some((item) => item.kind === "approval"))).toBe(true);
    expect(log().filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params?.value)).toContain("accept-edits");
    const card = items.get("s1")!.find((item) => item.kind === "approval")!;
    await adapter.answerApproval(session(), card.id, "decline");
    expect(await until(() => ended().length === 1)).toBe(true);
    expect(log().find((entry) => entry.event === "permission-answer")?.answer?.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
  }, 60_000);

  it("no inherited key, Cloud or Vertex variable reaches agy", async () => {
    const adapter = make({}, { GEMINI_API_KEY: "x", GOOGLE_API_KEY: "x", GOOGLE_CLOUD_PROJECT: "p", GOOGLE_GENAI_USE_VERTEXAI: "1" });
    await adapter.send(session(), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    const start = log().find((entry) => entry.event === "start" && entry.argv?.[0] === "acp");
    expect(start?.googleVars).toEqual([]);
  }, 60_000);

  it("멈춤 sends session/cancel and the turn ends as stopped", async () => {
    const adapter = make();
    await adapter.send(session(), work(), "길게 써 줘", "k1");
    expect(await until(() => (items.get("s1") ?? []).some((item) => item.kind === "assistant" && item.text.includes("3번째 줄")))).toBe(true);
    await adapter.interrupt(session());
    expect(await until(() => ended().length === 1)).toBe(true);
    expect(log().some((entry) => entry.method === "session/cancel")).toBe(true);
    expect(ended()[0]).toMatchObject({ status: "interrupted", cause: "stop" });
    expect(sessions.get("s1")?.status).toBe("idle");
  }, 60_000);

  it("steering: a request sent while a turn runs joins it", async () => {
    const adapter = make();
    await adapter.send(session(), work(), "길게 써 줘", "k1");
    expect(await until(() => (items.get("s1") ?? []).some((item) => item.kind === "assistant"))).toBe(true);
    expect(await adapter.steer(session(), work(), "표도 넣어", "k2")).toBe(true);
    expect(await until(() => ended().length === 1, 40_000)).toBe(true);
    const text = items.get("s1")!.filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join("");
    expect(text).toContain("끼어든 요청을 받았습니다: 표도 넣어");
    expect(dropped).toEqual([]);
  }, 60_000);

  it("reopen: a new process loads the conversation with session/load and does not draw agy's replay again", async () => {
    const first = make();
    await first.send(session(), work(), "첫 요청", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    const native = sessions.get("s1")!.nativeSessionId!;
    await first.shutdown();
    items.clear();
    const second = make();
    await second.send(session({ nativeSessionId: native }), work(), "둘째 요청", "k2");
    expect(await until(() => ended().length === 1)).toBe(true);
    const load = log().find((entry) => entry.method === "session/load");
    expect(load?.params?.sessionId).toBe(native);
    expect(log().filter((entry) => entry.method === "session/new")).toHaveLength(1);
    const texts = items.get("s1")!.filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : ""));
    expect(texts.join("\n")).not.toContain("첫 요청");
    expect(texts).toHaveLength(1);
  }, 60_000);

  it("the model and thinking level the picker chose are set through the session's own selectors", async () => {
    const adapter = make();
    await adapter.send(session({ model: "standin-flash", effort: "high" }), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    const sets = log().filter((entry) => entry.method === "session/set_config_option").map((entry) => `${entry.params?.configId}=${entry.params?.value}`);
    expect(sets).toEqual(expect.arrayContaining(["model=standin-flash", "thinking=high"]));
    const answer = items.get("s1")!.find((item) => item.kind === "assistant");
    expect(answer?.kind === "assistant" && answer.text).toContain("standin-flash · high");
  }, 60_000);

  it("an attached picture goes as ACP image content", async () => {
    const adapter = make();
    const picture = join(dir, "pic.png");
    writeFileSync(picture, PNG);
    await adapter.send(session(), work(), "이 그림 봐 줘", "k1", [{ path: picture, name: "pic.png", mime: "image/png" }]);
    expect(await until(() => ended().length === 1)).toBe(true);
    const prompt = log().find((entry) => entry.event === "prompt");
    expect(prompt?.images?.[0]?.bytes).toBe(PNG.length);
    const answer = items.get("s1")!.find((item) => item.kind === "assistant");
    expect(answer?.kind === "assistant" && answer.text).toContain("받은 그림 1장");
  }, 60_000);

  it("status: signed out, signed in after agy's own terminal login, old version, and no probe before the opt-in", async () => {
    const auth = join(dir, "auth");
    const out = make({}, { FAKE_ENGINE_AUTH_DIR: auth });
    await out.refreshStatus();
    expect(out.status()).toMatchObject({ installed: true, loggedIn: false });
    expect(out.status().gemini?.authMethods.map((method) => method.id)).toContain("terminal-login");
    await expect(out.send(session(), work(), "안녕", "k1")).rejects.toThrow(/로그인되어 있지 않습니다/);
    // The terminal tab runs `agy acp --login`; the person pastes the code into agy itself.
    expect(out.terminalLaunch("login")?.args.slice(-2)).toEqual(["acp", "--login"]);
    mkdirSync(auth, { recursive: true });
    writeFileSync(join(auth, "agy"), "x");
    await out.refreshStatus();
    expect(out.status()).toMatchObject({ loggedIn: true, loginMethod: "subscription" });

    const between = make({}, { FAKE_AGY_VERSION: "1.5.5" });
    await between.refreshStatus();
    expect(between.status().gemini).toMatchObject({ versionOk: true, versionRecommended: false });
    expect(out.status().gemini?.versionRecommended).toBe(true);

    const old = make({}, { FAKE_AGY_VERSION: "1.5.1" });
    await old.refreshStatus();
    expect(old.status().gemini?.versionOk).toBe(false);
    expect(old.status().error).toContain("1.5.2");

    const before = log().filter((entry) => entry.event === "start" && entry.argv?.[0] === "acp").length;
    const optOut = make({ googleOptIn: false });
    await optOut.refreshStatus();
    expect(optOut.status().loggedIn).toBeNull();
    expect(log().filter((entry) => entry.event === "start" && entry.argv?.[0] === "acp").length).toBe(before);
    await expect(optOut.send(session(), work(), "안녕", "k1")).rejects.toThrow(/동의/);
  }, 90_000);
});

describe("Gemini: what a prompt carries (only the person's request and minimal context)", () => {
  const big = { instructions: "[Achmage Workbench 맥락 카드] ".padEnd(1500, "가"), readOnly: false, excludeTmp: false };
  const browser = { pathDirs: () => [], sessionEnv: () => ({}), instructions: () => "playwright-cli 를 쓰는 방법 ".padEnd(800, "나"), offNote: () => "", allowsCommand: () => false, writableRoots: () => [], told: () => null, setTold: () => undefined, extraInstructions: () => "workbench-find, workbench-credential, workbench-desktop 사용법 ".padEnd(1200, "다") };

  it("agy that offers systemPrompt.append gets two plain lines there at most, never the other engines' card or tool manuals", async () => {
    const vault = join(dir, "vault");
    mkdirSync(vault, { recursive: true });
    const adapter = make({}, {}, { launch: () => big, browser, protectedRoots: () => [vault] });
    await adapter.send(session({ browser: true }), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    const append = ((log().find((entry) => entry.method === "session/new")?.params?._meta as { antigravity?: { systemPrompt?: { append?: string } } } | undefined)?.antigravity?.systemPrompt?.append) ?? "";
    expect(append).toContain("workbench-peers");
    expect(append.split("\n").length).toBeLessThanOrEqual(2);
    expect(append.length).toBeLessThan(300);
    for (const word of ["맥락 카드", "playwright", "workbench-find", "workbench-credential"]) expect(append).not.toContain(word);
    expect(log().find((entry) => entry.event === "prompt")?.text).toBe("안녕");
  }, 60_000);

  it("agy without such a place gets nothing but the person's text in the prompt", async () => {
    const adapter = make({}, { FAKE_AGY_NO_APPEND: "1" }, { launch: () => big, browser });
    await adapter.send(session({ browser: true }), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    expect(log().find((entry) => entry.event === "prompt")?.text).toBe("안녕");
    expect(log().find((entry) => entry.method === "session/new")?.params?._meta).toBeUndefined();
  }, 60_000);
});

describe("Gemini: an account Google blocked (study § H)", () => {
  it("recognises agy's wording and keeps only Google's own appeal address", () => {
    expect(suspensionOf("This account has been disabled for violation of Terms of Service. To appeal, visit https://antigravity.google/appeal-standin")).toEqual({ appeal: "https://antigravity.google/appeal-standin" });
    expect(suspensionOf("Your Antigravity access is suspended. Appeal at https://support.google.com/x/answer/1?hl=en.")).toEqual({ appeal: "https://support.google.com/x/answer/1?hl=en" });
    expect(suspensionOf("Account blocked for a Terms of Service violation; see https://evil.example/appeal")).toEqual({ appeal: null });
    expect(suspensionOf("RESOURCE_EXHAUSTED: quota exceeded")).toBeNull();
    expect(suspensionOf("Authentication required")).toBeNull();
  });

  it("a prompt refused for a ToS block: one clear line in the conversation and the card, and no retrying", async () => {
    const flag = join(dir, "suspended");
    const adapter = make({}, { FAKE_AGY_SUSPENDED_FILE: flag });
    await adapter.send(session(), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    writeFileSync(flag, "x");
    await adapter.send(session({ nativeSessionId: sessions.get("s1")!.nativeSessionId! }), work(), "또 안녕", "k2");
    expect(await until(() => ended().length === 2)).toBe(true);
    const notice = items.get("s1")!.find((item) => item.kind === "notice" && item.text.includes(GEMINI_SUSPENDED));
    expect(notice && notice.kind === "notice" && notice.text).toContain("https://antigravity.google/appeal-standin");
    expect(adapter.status().gemini?.suspended).toEqual({ appeal: "https://antigravity.google/appeal-standin" });
    const prompts = log().filter((entry) => entry.event === "prompt").length, starts = log().filter((entry) => entry.event === "start").length;
    await expect(adapter.send(session({ nativeSessionId: sessions.get("s1")!.nativeSessionId! }), work(), "셋째", "k3")).rejects.toThrow(GEMINI_SUSPENDED);
    expect(log().filter((entry) => entry.event === "prompt")).toHaveLength(prompts);
    expect(log().filter((entry) => entry.event === "start")).toHaveLength(starts);
  }, 60_000);

  it("the status check finds the block too, and clears it once agy works again", async () => {
    const flag = join(dir, "suspended");
    writeFileSync(flag, "x");
    const adapter = make({}, { FAKE_AGY_SUSPENDED_FILE: flag });
    await adapter.refreshStatus();
    expect(adapter.status().gemini?.suspended).toEqual({ appeal: "https://antigravity.google/appeal-standin" });
    expect(adapter.status().error).toContain(GEMINI_SUSPENDED);
    rmSync(flag);
    await adapter.refreshStatus();
    expect(adapter.status().gemini?.suspended ?? null).toBeNull();
    expect(adapter.status().loggedIn).toBe(true);
  }, 60_000);
});

describe("Gemini: never 'always allow' (security review 5)", () => {
  const onlyAlways = [{ optionId: "aa", name: "Always allow", kind: "allow_always" }, { optionId: "r1", name: "Reject", kind: "reject_once" }];
  it("permissionOption never picks allow_always", () => {
    expect(permissionOption(onlyAlways, "accept")).toBeNull();
    expect(permissionOption(onlyAlways, "decline")).toBe("r1");
  });
  it("when agy offers only 'always allow', the request is answered reject once with one line, and no card waits", async () => {
    const adapter = make();
    await adapter.send(session({ access: "auto" }), work(), "명령 항상만", "k1");
    expect(await until(() => ended().length === 1, 10_000)).toBe(true);
    expect(log().find((entry) => entry.event === "permission-answer")?.answer?.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(items.get("s1")!.some((item) => item.kind === "approval" && item.decision === null)).toBe(false);
    expect(items.get("s1")!.some((item) => item.kind === "notice" && item.text.includes("항상 허용"))).toBe(true);
  }, 60_000);
});

describe("Gemini: a running agy and the opt-in (security review 3)", () => {
  it("is not reused once the opt-in is withdrawn", async () => {
    const live: GeminiSettings = { googleOptIn: true };
    const adapter = make({}, {}, { settings: () => live });
    await adapter.send(session(), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    live.googleOptIn = false;
    await expect(adapter.send(session({ nativeSessionId: sessions.get("s1")!.nativeSessionId! }), work(), "또 안녕", "k2")).rejects.toThrow(/동의/);
    expect(log().filter((entry) => entry.event === "prompt")).toHaveLength(1);
  }, 60_000);
});

describe("Gemini and the vault (security review 2)", () => {
  const vaultSetup = () => {
    const vault = join(dir, "vault");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "note.md"), "# 원본\n");
    // A link inside the project folder that leads into the vault: the check follows it.
    symlinkSync(vault, join(work().cwd, "vault-link"));
    return vault;
  };

  it("with a vault attached, 자동 runs agy in its default mode so every edit is asked of Workbench", async () => {
    const vault = vaultSetup();
    const adapter = make({}, {}, { protectedRoots: () => [vault] });
    await adapter.send(session({ access: "auto" }), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    const modes = log().filter((entry) => entry.method === "session/set_config_option" && entry.params?.configId === "mode").map((entry) => entry.params?.value);
    expect(modes).not.toContain("accept-edits");
  }, 60_000);

  it("an edit into the vault through a link in the project folder is refused, in 자동 too, and the note is untouched", async () => {
    const vault = vaultSetup();
    const adapter = make({}, {}, { protectedRoots: () => [vault] });
    await adapter.send(session({ access: "auto" }), work(), "파일: vault-link/note.md 고쳐", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    expect(readFileSync(join(vault, "note.md"), "utf8")).toBe("# 원본\n");
    expect(log().find((entry) => entry.event === "permission-answer")?.answer?.outcome).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect(items.get("s1")!.some((item) => item.kind === "notice" && item.text.includes("볼트"))).toBe(true);
  }, 60_000);

  it("an edit outside the vault in 자동 still goes without a card (what accept-edits did)", async () => {
    const vault = vaultSetup();
    const adapter = make({}, {}, { protectedRoots: () => [vault] });
    await adapter.send(session({ access: "auto" }), work(), "파일: notes.md 고쳐", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    expect(items.get("s1")!.some((item) => item.kind === "approval")).toBe(false);
    expect(readFileSync(join(work().cwd, "notes.md"), "utf8")).toContain("Gemini 대역");
  }, 60_000);

  it("without a vault, 자동 is agy's accept-edits as before", async () => {
    const adapter = make({}, {}, { protectedRoots: () => [] });
    await adapter.send(session({ access: "auto" }), work(), "안녕", "k1");
    expect(await until(() => ended().length === 1)).toBe(true);
    expect(log().filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params?.value)).toContain("accept-edits");
  }, 60_000);
});

describe("Gemini: no headless agy anywhere (§ G rule 7)", () => {
  const banned = /["'`](-p|--print|--prompt|--dangerously-skip-permissions|--output-format|--input-format)["'`]/;
  // Code only: the comments explain the rule and name the flags.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  it("the Gemini sources never pass -p / --print / --dangerously-skip-permissions to agy", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = readdirSync(here).filter((name) => /^gemini.*\.ts$/.test(name) && !name.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const name of files) expect(code(readFileSync(join(here, name), "utf8")), name).not.toMatch(banned);
  });
  it("the built gateway's Gemini modules do not either (when a build is present)", () => {
    const built = join(repo, "apps/host/dist/host.mjs");
    if (!existsSync(built)) return;
    const text = readFileSync(built, "utf8");
    // esbuild marks each module with its source path; take the Gemini ones.
    const sections = text.split(/\n(?=\/\/ (?:src|apps\/host\/src)\/)/).filter((part) => /^\/\/ (?:src|apps\/host\/src)\/providers\/gemini/.test(part));
    for (const part of sections) expect(part.split("\n")[0]).toBeTruthy();
    for (const part of sections) expect(code(part)).not.toMatch(banned);
    if (sections.length) expect(sections.join("\n")).toContain('"--disable-telemetry"');
  });
});

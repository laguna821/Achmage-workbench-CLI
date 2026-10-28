import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalDecision, ProviderStatus, Session, Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { DIKM_KEYS, checkInsight, frontmatterKeys } from "./insight.ts";
import { Pkm } from "./pkm.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";
import { makeFixtureVault, put } from "./vault-fixture.ts";

// "인사이트 초안" on a fixture vault in a temporary folder; nothing is published anywhere.

class Engine implements ProviderAdapter {
  readonly provider: "claude" | "codex";
  readonly texts: string[] = [];
  private readonly sink: () => AdapterSink;
  constructor(provider: "claude" | "codex", sink: () => AdapterSink) {
    this.provider = provider;
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return emptyStatus(this.provider);
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session, _work: Work, text: string, turnKey: string) {
    this.texts.push(text);
    const sink = this.sink();
    const reply = "## 정리\n\n수업에서 AI가 고친 글을 학생이 다시 고치게 한다. 그러면 무엇이 바뀌었는지 말로 설명하게 된다.\n\n- 첫째 요점이다. 덧붙인 설명은 접힌다.\n- 둘째 요점이다.";
    sink.upsertItem(session.id, { kind: "assistant", id: `a:${turnKey}`, text: reply, streaming: false, at: Date.now() });
    sink.upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 1, at: Date.now() });
    sink.updateSession(session.id, { status: "idle" });
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

const TEMPLATE = ["---", "title:", "aliases:", '"DIKM_단계:":', "  - 🟢 D", "  - 🔵 I", '"종류:":', "  - 노트", "tags:", '"저자:": ', "date created:", "source:", "---", "", "## 템플릿 본문", ""].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function files(root: string) {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${full}:${statSync(full).mtimeMs}:${statSync(full).size}`);
    }
  };
  walk(root);
  return out.sort();
}

async function setup(withVault = true) {
  const dir = mkdtempSync(join(tmpdir(), "wb-insight-"));
  dirs.push(dir);
  const vault = makeFixtureVault(join(dir, "vault"));
  put(vault, "90. Settings/91. Templates/New DIKM Note 2026.md", TEMPLATE);
  const store = new Store(join(dir, "state.sqlite"));
  const bus = new EventBus();
  const manager = new SessionManager(store, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
  const engine = new Engine("codex", () => manager.sink);
  manager.registerAdapter(engine);
  const pkm = new Pkm(store, bus, manager, { dataDir: dir });
  if (withVault) pkm.attachVault(vault);
  const work = manager.createWork({ title: "수업 연구" });
  const session = manager.createSession(work.id, { provider: "codex", purpose: "AI 글쓰기 수업" });
  await manager.send(session.id, "r1", "AI 글쓰기 수업에서 무엇을 바꿀까?");
  return { dir, vault, manager, pkm, engine, session };
}

describe("insight drafts", () => {
  it("uses the vault template's keys exactly, leaves DIKM empty and fills only title, date and source", async () => {
    const { pkm, session } = await setup();
    const draft = pkm.insight(session.id);
    expect(draft.template).toBe("90. Settings/91. Templates/New DIKM Note 2026.md");
    expect(draft.keys).toEqual(["title", "aliases", "DIKM_단계:", "종류:", "tags", "저자:", "date created", "source"]);
    expect(frontmatterKeys(draft.text)).toEqual(draft.keys);
    expect(draft.text).toMatch(/^---\ntitle: AI 글쓰기 수업\naliases:\n"DIKM_단계:":\n"종류:":\ntags:\n"저자:": \ndate created: \d{4}-\d{2}-\d{2}T[\d:]+[+-]\d{2}:\d{2}\nsource: workbench:\/\/session\//);
    expect(draft.text).toContain("> AI 글쓰기 수업에서 무엇을 바꿀까?");
    expect(draft.text).toContain("- 요청 1: AI 글쓰기 수업에서 무엇을 바꿀까?");
    expect(draft.problems).toEqual([]);
  });

  it("refuses misspelled or missing keys, a DIKM stage set by hand and an empty title", async () => {
    const { pkm, session } = await setup();
    const { text, keys } = pkm.insight(session.id);
    expect(checkInsight(text.replace('"DIKM_단계:":', '"DIKM_단계":'), keys).join(" ")).toContain("DIKM_단계:");
    expect(checkInsight(text.replace('"DIKM_단계:":', '"DIKM_단계:":\n  - 🟣 K'), keys).join(" ")).toContain("비워 두세요");
    expect(checkInsight(text.replace(/^title: .*$/m, "title:"), keys).join(" ")).toContain("title");
    expect(checkInsight(text.replace("tags:", "tags:\n새키: 값"), keys).join(" ")).toContain("새키");
    expect(checkInsight("앞머리 없음", keys)).toEqual(["앞머리(---)가 없습니다."]);
  });

  it("publishes only by asking the session's engine to use Achmage MCP, and never writes the vault", async () => {
    const { pkm, session, engine, vault } = await setup();
    const before = files(vault);
    const { text } = pkm.insight(session.id);
    await expect(pkm.publishInsight(session.id, text.replace("source:", "출처:"), "bad")).rejects.toThrow();
    const result = await pkm.publishInsight(session.id, text, "publish-1");
    expect(result).toMatchObject({ delivery: "turn", requestId: "publish-1" });
    const asked = engine.texts.at(-1)!;
    expect(asked).toContain("[인사이트 발행 요청 · Achmage Workbench]");
    expect(asked).toContain("draft_insight");
    expect(asked).toContain("publish_insight");
    expect(asked).toContain(text.trimEnd());
    expect(files(vault)).toEqual(before);
  });

  it("falls back to the DIKM keys of the metadata policy without a vault template", async () => {
    const { pkm, session } = await setup(false);
    const draft = pkm.insight(session.id);
    expect(draft.template).toBeNull();
    expect(frontmatterKeys(draft.text)).toEqual(DIKM_KEYS);
    expect(draft.problems).toEqual([]);
  });
});

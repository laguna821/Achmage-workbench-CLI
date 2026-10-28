import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accessFor, type AccessMode, type ApprovalDecision, type ProviderStatus, type Session, type Work } from "@workbench/contracts";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";
import { configuredAccess as claudeAccess, usageFromPlan } from "./providers/claude.ts";
import { configuredAccess as codexAccess, isToolApproval } from "./providers/codex.ts";
import { emptyStatus, type AdapterSink, type ProviderAdapter } from "./providers/types.ts";

// How freely an engine acts: the engine's own settings, the user's last pick, the session's choice.

describe("access defaults", () => {
  it("reads what the engines' own settings allow", () => {
    expect(claudeAccess(JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }))).toBe("full");
    expect(claudeAccess(JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }))).toBe("auto");
    expect(claudeAccess(JSON.stringify({ permissions: { defaultMode: "default" } }))).toBe("ask");
    expect(claudeAccess(JSON.stringify({}))).toBeNull();
    expect(claudeAccess(null)).toBeNull();
    expect(codexAccess({ approval_policy: "never", sandbox_mode: "danger-full-access" })).toBe("full");
    expect(codexAccess({ approval_policy: "on-request", sandbox_mode: "workspace-write" })).toBe("auto");
    expect(codexAccess({ approval_policy: "untrusted", sandbox_mode: null })).toBe("ask");
    expect(codexAccess({ approval_policy: null, sandbox_mode: null })).toBeNull();
  });

  it("a session's own choice, else the last pick for its engine, else the engine's settings, else auto", () => {
    expect(accessFor("claude", "ask", { access: { claude: "full" } }, "full")).toBe("ask");
    expect(accessFor("claude", null, { access: { claude: "full" } }, "ask")).toBe("full");
    expect(accessFor("codex", null, { access: { claude: "full" } }, "ask")).toBe("ask");
    expect(accessFor("codex", null, { access: { codex: "bogus" } }, null)).toBe("auto");
  });

  it("tells an MCP tool approval from an MCP server asking for real input", () => {
    const base = { threadId: "t", turnId: "u", serverName: "achmage", message: "m" };
    expect(isToolApproval({ ...base, mode: "form", _meta: { codex_approval_kind: "mcp_tool_call" }, requestedSchema: { type: "object", properties: { x: { type: "string" } } } } as never)).toBe(true);
    expect(isToolApproval({ ...base, mode: "form", _meta: null, requestedSchema: { type: "object", properties: {} } } as never)).toBe(true);
    expect(isToolApproval({ ...base, mode: "form", _meta: null, requestedSchema: { type: "object", properties: { name: { type: "string" } } } } as never)).toBe(false);
    expect(isToolApproval({ ...base, mode: "url", _meta: null, url: "https://example.com", elicitationId: "e" } as never)).toBe(false);
  });

  it("reads Claude plan limits from get_usage (0–100, ISO reset)", () => {
    expect(usageFromPlan({ five_hour: { utilization: 42.5, resets_at: "2026-10-28T12:00:00Z" }, seven_day: { utilization: 17, resets_at: null }, model_scoped: [] })).toEqual([
      { label: "5시간", usedPercent: 42.5, resetsAt: Date.parse("2026-10-28T12:00:00Z") },
      { label: "주간", usedPercent: 17, resetsAt: null },
    ]);
    expect(usageFromPlan(null)).toEqual([]);
  });
});

class AccessEngine implements ProviderAdapter {
  readonly provider = "claude" as const;
  configured: AccessMode | null = "full";
  sentWith: AccessMode[] = [];
  applied: AccessMode[] = [];
  private readonly sink: () => AdapterSink;
  constructor(sink: () => AdapterSink) {
    this.sink = sink;
  }
  async init() {}
  status(): ProviderStatus {
    return { ...emptyStatus("claude"), configuredAccess: this.configured };
  }
  async refreshStatus() {
    return this.status();
  }
  async login() {
    return { url: null, message: "" };
  }
  async send(session: Session & { access: AccessMode }, _work: Work, _text: string, turnKey: string) {
    this.sentWith.push(session.access);
    setTimeout(() => {
      this.sink().upsertItem(session.id, { kind: "turnEnd", id: `end:${turnKey}`, status: "completed", durationMs: 1, at: Date.now() });
      this.sink().updateSession(session.id, { status: "idle", activity: null });
    }, 0);
  }
  async setAccess(session: Session & { access: AccessMode }) {
    this.applied.push(session.access);
  }
  async interrupt() {}
  async answerApproval(_session: Session, _itemId: string, _decision: ApprovalDecision) {
    return false;
  }
  async shutdown() {}
}

const tick = () => new Promise((done) => setTimeout(done, 5));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a session's access", () => {
  it("follows the engine's settings until picked, reaches the engine at once, and is remembered per engine by the UI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-access-"));
    dirs.push(dir);
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works") });
    const engine = new AccessEngine(() => manager.sink);
    manager.registerAdapter(engine);
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "claude" });
    expect(session.access).toBeNull();

    await manager.send(session.id, "r1", "첫 요청");
    await tick();
    expect(engine.sentWith).toEqual(["full"]);

    manager.updateSession(session.id, { access: "ask" });
    expect(engine.applied).toEqual(["ask"]);
    await manager.send(session.id, "r2", "둘째");
    await tick();
    expect(engine.sentWith).toEqual(["full", "ask"]);

    // A session left on the default follows the pick the UI keeps for the engine.
    const other = manager.createSession(work.id, { provider: "claude" });
    manager.setPrefs({ access: { claude: "auto" } });
    await manager.send(other.id, "r3", "셋째");
    expect(engine.sentWith.at(-1)).toBe("auto");
    expect(() => manager.updateSession(other.id, { access: "everything" as AccessMode })).toThrow();
  });
});

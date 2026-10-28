import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// "알림 끄기": a session that does not notify, kept across restarts, without reordering the list.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("알림 끄기", () => {
  it("is kept per session, survives a restart and leaves the list order alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-mute-"));
    dirs.push(dir);
    const open = () => new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    const manager = open();
    const work = manager.createWork({ title: "w" });
    const session = manager.createSession(work.id, { provider: "codex" });
    const muted = manager.updateSession(session.id, { muted: true });
    expect(muted.muted).toBe(true);
    expect(muted.updatedAt).toBe(session.updatedAt);
    expect(open().snapshot().sessions.find((entry) => entry.id === session.id)?.muted).toBe(true);
    expect(manager.updateSession(session.id, { muted: false }).muted).toBe(false);
  });
});

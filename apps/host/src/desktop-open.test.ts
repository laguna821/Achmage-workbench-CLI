import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "./bus.ts";
import { openWithDesktop } from "./desktop-open.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

vi.mock("./desktop-open.ts", () => ({ openWithDesktop: vi.fn() }));
const managers: SessionManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.stopExternalWatches(); vi.clearAllMocks(); });

describe("explicit external document editing", () => {
  it("opens the default app and retains external saves as revisions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-external-"));
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    managers.push(manager);
    const work = manager.createWork({ title: "보고서", cwd: join(dir, "project") });
    mkdirSync(work.cwd, { recursive: true });
    const path = join(work.cwd, "보고서.hwpx"); writeFileSync(path, "first version");
    const artifact = manager.openFile(work.id, "보고서.hwpx");
    expect(await manager.openExternal(artifact.id, "default")).toEqual({ app: "기본 앱" });
    expect(openWithDesktop).toHaveBeenCalledWith(path);
    writeFileSync(path, "edited externally");
    await vi.waitFor(() => expect(manager.documents.get(artifact.id).revision).toBe(2), { timeout: 5000 });
    expect(manager.documents.revisions(artifact.id)[1]).toMatchObject({ author: "external", note: "기본 앱에서 저장" });
  });
});

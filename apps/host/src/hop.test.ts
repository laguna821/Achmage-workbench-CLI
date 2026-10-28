import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "./bus.ts";
import { findHop } from "./hop.ts";
import { SessionManager } from "./sessions.ts";
import { Store } from "./store.ts";

// HOP is a separate desktop app; a stand-in launcher records how it was started instead.

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopExternalWatches();
  delete process.env.WORKBENCH_HOP_BIN;
});

function fakeHop(dir: string) {
  const log = join(dir, "hop-args.txt");
  const launcher = join(dir, "achmage-hop");
  writeFileSync(launcher, `#!/bin/sh\n# exec "/x/achmage-hop/1.2.0-test/usr/bin/hop-desktop"\nprintf '%s\\n' "$@" > "${log}"\n`);
  chmodSync(launcher, 0o755);
  return { launcher, log };
}

describe("Achmage HOP", () => {
  it("finds the user's launcher and its version", () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-hop-"));
    const { launcher } = fakeHop(dir);
    expect(findHop({ WORKBENCH_HOP_BIN: launcher, PATH: "" })).toEqual({ launcher, version: "1.2.0-test" });
  });

  it("opens a Hangul document in HOP and takes what HOP saves as the next revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-hop-"));
    const { launcher, log } = fakeHop(dir);
    process.env.WORKBENCH_HOP_BIN = launcher;
    const manager = new SessionManager(new Store(join(dir, "state.sqlite")), new EventBus(), { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
    managers.push(manager);
    const work = manager.createWork({ title: "보고서", cwd: join(dir, "project") });
    mkdirSync(work.cwd, { recursive: true });
    writeFileSync(join(work.cwd, "보고서.hwpx"), "first version");
    const artifact = manager.openFile(work.id, "보고서.hwpx");

    expect(manager.openExternal(artifact.id)).toEqual({ app: "HOP" });
    await new Promise((done) => setTimeout(done, 300));
    expect(readFileSync(log, "utf8").trim()).toBe(join(work.cwd, "보고서.hwpx"));

    // HOP saves the document.
    writeFileSync(join(work.cwd, "보고서.hwpx"), "edited in HOP");
    await new Promise((done) => setTimeout(done, 3500));
    expect(manager.documents.get(artifact.id).revision).toBe(2);
    expect(manager.documents.revisions(artifact.id)[1]).toMatchObject({ author: "external", note: "HOP에서 저장" });
  }, 15_000);
});

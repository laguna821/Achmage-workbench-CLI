import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Achmage, briefFrom } from "./achmage.ts";
import { contextCard } from "./pkm-guard.ts";

// The Achmage line of a project page, with a stand-in launcher (the user's runtime is never run).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ID = "work-1b7f68199bcb4756b2a7fd2a102ccc2e";

describe("an Achmage work's brief", () => {
  it("reads the work's title, last capture and devices, and a summary when the context has one", () => {
    const json = { status: "ok", candidates: [{ workId: ID, title: "작업실", lastCapturedAt: "2026-10-29T03:46:32+00:00", devices: ["laptop-linux"] }], context: { summary: "프로젝트 노트를 만든다." } };
    expect(briefFrom(ID, json)).toEqual({ workId: ID, found: true, title: "작업실", lastCapturedAt: Date.parse("2026-10-29T03:46:32Z"), devices: ["laptop-linux"], summary: "프로젝트 노트를 만든다." });
    expect(briefFrom(ID, { status: "context-unavailable", candidates: [], context: null })).toMatchObject({ found: false, title: null, summary: null });
  });

  it("asks the launcher once per ten minutes, and gives nothing without one or for a value that is not a work id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wb-achmage-"));
    dirs.push(dir);
    const launcher = join(dir, "launcher.py");
    const calls = join(dir, "calls");
    writeFileSync(
      launcher,
      ["import json, sys", `open(${JSON.stringify(calls)}, "a").write(" ".join(sys.argv[1:]) + "\\n")`, `print(json.dumps({"candidates": [{"workId": sys.argv[sys.argv.index("--work-id") + 1], "title": "작업실", "devices": []}]}))`].join("\n"),
    );
    const achmage = new Achmage(launcher, join(dir, "state"));
    expect(await achmage.brief(ID)).toMatchObject({ found: true, title: "작업실" });
    expect(await achmage.brief(ID)).toMatchObject({ found: true });
    expect((await import("node:fs")).readFileSync(calls, "utf8").trim().split("\n")).toEqual([`--state ${join(dir, "state")} work-brief --work-id ${ID} --max-chars 4000`]);
    expect(await achmage.brief("work-x; rm -rf /")).toBeNull();
    expect(await new Achmage(join(dir, "none.py"), dir).brief(ID)).toBeNull();
  });

  it("names the work in a new session's card, so an engine publishing an insight does not guess it", () => {
    const card = contextCard({ title: "t", folders: [], cwd: "/w", vault: null, pinned: [], project: { note: "/w/t.md", exists: true, stage: null, tags: [], decisions: [], questions: [], achmage: ID } });
    expect(card).toContain(`Achmage 작업: ${ID} — 인사이트를 낼 때 이 작업 id를 쓰세요.`);
  });
});

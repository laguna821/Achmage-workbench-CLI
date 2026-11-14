import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanKits, pair, say, settle, startKit, type Kit } from "./test-kit.ts";

// Re-review 1, fix round 2: the first page of a Hangul document as a PNG the phone shows (page 1
// only, made off the gateway's main thread, bounded), with the SVG as the fallback.

afterEach(() => { vi.restoreAllMocks(); cleanKits(); });

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "강의계획서.hwpx");
const PNG_SIGNATURE = "89504e470d0a1a0a";

async function hangulTurn(kit: Kit, name = "강의계획서.hwpx") {
  await say(kit, "강의계획서 만들어 줘");
  const { sessionId } = kit.engine.sent.at(-1)!;
  const workId = kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId;
  copyFileSync(FIXTURE, join(kit.manager.workCwd(workId), name));
  const artifact = kit.manager.openFile(workId, name);
  kit.manager.sink.upsertItem(sessionId, { kind: "artifact", id: "artifact:1", artifactId: artifact.id, revision: artifact.revision, change: "created", at: Date.now() });
  kit.engine.say(sessionId, "강의계획서를 만들었습니다.");
  kit.engine.finish(sessionId);
  await settle(kit);
  return kit.adapter.last()!;
}

describe("the first page of a Hangul document (R4, option A)", () => {
  it("goes as a PNG picture, from page 1 only and without the page cache, beside the original", async () => {
    const kit = await startKit();
    await pair(kit);
    const pages = vi.spyOn(kit.manager.documents, "pages");
    await hangulTurn(kit);
    expect(pages).not.toHaveBeenCalled();
    const [original, picture] = kit.adapter.uploads;
    expect(original).toMatchObject({ name: "강의계획서.hwpx" });
    expect(original!.bytes.equals(readFileSync(FIXTURE))).toBe(true);
    expect(picture).toMatchObject({ name: "강의계획서 1쪽.png", mime: "image/png", caption: "1쪽 미리보기 · 강의계획서.hwpx" });
    expect(picture!.bytes.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
    // About 1200 px wide (the PNG header's width field).
    expect(picture!.bytes.readUInt32BE(16)).toBe(1200);
  }, 30_000);

  it("sends no picture when the picture cannot be made (fix round 3: the gateway draws nothing itself), and says so in the record, not in the chat", async () => {
    const kit = await startKit();
    kit.core.rasterize = async () => ({ ok: false, code: "timeout" });
    await pair(kit);
    const answer = await hangulTurn(kit);
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["강의계획서.hwpx"]);
    expect(answer.out.text).toBe("강의계획서를 만들었습니다.");
    expect(kit.core.auditList().some((row) => row.action === "preview.fallback" && row.result === "timeout")).toBe(true);
  }, 30_000);

  it("makes no picture above the size limit, says the limit in the chat, and still sends the original", async () => {
    const kit = await startKit();
    kit.core.previewLimitBytes = 1000;
    const made = vi.fn();
    kit.core.rasterize = async (...args) => { made(...args); return { ok: false, code: "failed" }; };
    await pair(kit);
    const answer = await hangulTurn(kit);
    expect(made).not.toHaveBeenCalled();
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["강의계획서.hwpx"]);
    expect(answer.out.text).toContain("「강의계획서.hwpx」은(는) 1MB가 넘어 1쪽 미리보기를 만들지 않았습니다. 원본은 함께 보냅니다.");
    void writeFileSync;
  }, 30_000);
});

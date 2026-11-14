import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedReason } from "./files.ts";
import { cleanKits, openKit, pair, press, say, settle, startKit, type Kit } from "./test-kit.ts";

// Review of units 5–6, fix round 1: files out (latest revision, the cap, captions, the line about
// files that did not go), files in (limits said), and the channel's own folders.

afterEach(() => { vi.restoreAllMocks(); cleanKits(); });

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const TOKEN = "7000000001:AAF" + "k".repeat(8) + "-Fake_token-for-loopback-01";

async function turn(kit: Kit, answer: string, during: (sessionId: string, cwd: string, workId: string) => void = () => undefined) {
  await say(kit, "일 하나");
  const { sessionId } = kit.engine.sent.at(-1)!;
  const workId = kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId;
  during(sessionId, kit.manager.workCwd(workId), workId);
  kit.engine.say(sessionId, answer);
  kit.engine.finish(sessionId);
  await settle(kit);
  return kit.adapter.last()!;
}

const artifactItem = (kit: Kit, sessionId: string, id: string, artifact: { id: string; revision: number }) =>
  kit.manager.sink.upsertItem(sessionId, { kind: "artifact", id, artifactId: artifact.id, revision: artifact.revision, change: "modified", at: Date.now() });

describe("files out", () => {
  it("sends the latest revision of a document the turn changed twice (I2)", async () => {
    const kit = await startKit();
    await pair(kit);
    await turn(kit, "보고서를 고쳤습니다.", (sessionId, cwd, workId) => {
      writeFileSync(join(cwd, "보고서.md"), "# 초안\n");
      const first = kit.manager.openFile(workId, "보고서.md");
      artifactItem(kit, sessionId, "artifact:a", first);
      writeFileSync(join(cwd, "보고서.md"), "# 고친 판\n");
      const second = kit.manager.openFile(workId, "보고서.md");
      expect(second.revision).toBeGreaterThan(first.revision);
      artifactItem(kit, sessionId, "artifact:b", second);
    });
    expect(kit.adapter.uploads.map((file) => [file.name, file.bytes.toString("utf8")])).toEqual([["보고서.md", "# 고친 판\n"]]);
  });

  it("sends at most ten files with an answer, first-page pictures counted, and says the rest are at the PC (I5, M5)", async () => {
    const kit = await startKit();
    kit.core.preview = async (artifact) => { const file = join(kit.dataDir, `${artifact.id}.png`); writeFileSync(file, PNG); return file; };
    await pair(kit);
    const answer = await turn(kit, "엑셀 일곱 개를 만들었습니다.", (sessionId, cwd, workId) => {
      for (let index = 1; index <= 7; index += 1) {
        writeFileSync(join(cwd, `표${index}.xlsx`), `PK ${index}`);
        artifactItem(kit, sessionId, `artifact:${index}`, kit.manager.openFile(workId, `표${index}.xlsx`));
      }
    });
    expect(kit.adapter.uploads).toHaveLength(10);
    expect(answer.out.text).toContain("파일이 많아 10개만 보냈습니다. 나머지는 PC에서 보세요.");
  });

  it("hides secrets in the captions of first-page pictures (I5)", async () => {
    const kit = await startKit();
    kit.core.preview = async (artifact) => { const file = join(kit.dataDir, `${artifact.id}.png`); writeFileSync(file, PNG); return file; };
    await pair(kit);
    await turn(kit, "만들었습니다.", (sessionId, cwd, workId) => {
      writeFileSync(join(cwd, `키-${TOKEN}.docx`), "PK");
      artifactItem(kit, sessionId, "artifact:1", kit.manager.openFile(workId, `키-${TOKEN}.docx`));
    });
    const caption = kit.adapter.uploads.find((file) => file.caption)!.caption!;
    expect(caption).toMatch(/^1쪽 미리보기 · 키-/);
    expect(caption).not.toContain(TOKEN);
  });

  it("sends the answer's files again with 마지막 답 보기, not only its text (M10)", async () => {
    const kit = await startKit();
    await pair(kit);
    await turn(kit, "만들었습니다.\n파일: 결과.txt", (_sessionId, cwd) => { writeFileSync(join(cwd, "결과.txt"), "결과"); kit.adapter.failures.push("unknown"); });
    expect(kit.adapter.uploads).toEqual([]);
    await say(kit, "받았나?");
    await press(kit, "마지막 답 보기");
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["결과.txt"]);
  });

  it("names the files that did not go with a 마지막 답 보기 re-send too (round 2)", async () => {
    const kit = await startKit();
    await pair(kit);
    await turn(kit, "만들었습니다.\n파일: 결과.txt", (_sessionId, cwd) => { writeFileSync(join(cwd, "결과.txt"), "결과"); kit.adapter.failures.push("unknown"); });
    await say(kit, "받았나?");
    kit.adapter.refuseFiles.add("결과.txt");
    await press(kit, "마지막 답 보기");
    expect(kit.adapter.texts().at(-1)).toBe("「결과.txt」은(는) 보내지 못했습니다. PC에서 열어 보세요.");
  });

  it("records 1쪽 보기 as a file sent (M6)", async () => {
    const kit = await startKit();
    kit.core.preview = async () => { const file = join(kit.dataDir, "p.png"); writeFileSync(file, PNG); return file; };
    await pair(kit);
    await say(kit, "첫 일");
    kit.engine.finish(kit.engine.sent[0]!.sessionId);
    await settle(kit);
    const work = kit.manager.snapshot().works[0]!;
    writeFileSync(join(work.cwd, "예산표.xlsx"), "PK");
    kit.manager.openFile(work.id, "예산표.xlsx");
    await say(kit, "메뉴");
    await press(kit, "최근 파일");
    await press(kit, "예산표.xlsx");
    const before = kit.core.auditList().filter((row) => row.action === "file.sent").length;
    await press(kit, "1쪽 보기");
    expect(kit.core.auditList().filter((row) => row.action === "file.sent")).toHaveLength(before + 1);
  });
});

describe("Hangul files (.hwp and .hwpx)", () => {
  it.each([["hwp"], ["hwpx"]])("go as the original file with the first page the gateway's own Hangul renderer draws (.%s)", async (ext) => {
    const kit = await startKit();
    await pair(kit);
    const pages = vi.fn();
    kit.core.rasterize = async (path, format, out) => { pages(path, format); writeFileSync(out, PNG); return { ok: true, renderMs: 1, rasterMs: 1, fontBytes: 0, rss: 0 }; };
    await turn(kit, "만들었습니다.", (sessionId, cwd, workId) => {
      writeFileSync(join(cwd, `계획서.${ext}`), "HWP bytes");
      artifactItem(kit, sessionId, "artifact:1", kit.manager.openFile(workId, `계획서.${ext}`));
    });
    expect(pages).toHaveBeenCalledTimes(1);
    expect(pages).toHaveBeenCalledWith(expect.any(String), ext);
    expect(kit.adapter.uploads.map((file) => [file.name, file.caption ?? null])).toEqual([[`계획서.${ext}`, null], ["계획서 1쪽.png", `1쪽 미리보기 · 계획서.${ext}`]]);
    expect(kit.adapter.uploads[0]!.bytes.toString("utf8")).toBe("HWP bytes");
  });
});

describe("files in", () => {
  it("says the limit when a file grows past it while it is fetched (M7)", async () => {
    const kit = await startKit();
    await pair(kit);
    vi.spyOn(kit.adapter, "download").mockRejectedValue(Object.assign(new Error("too large"), { delivered: "no", code: "too_large" }));
    await kit.adapter.deliver(kit.adapter.message("봐 줘", { files: [{ fileRef: "f", name: "영상.mp4", mime: "video/mp4", size: 1000, kind: "file" }] }));
    await settle(kit);
    expect(kit.adapter.texts()).toContain("「영상.mp4」은(는) 20MB가 넘어 받지 못했습니다. 텔레그램 봇이 받을 수 있는 파일은 20MB까지입니다.");
  });

  it("says an empty file is empty instead of asking to send it again (M7)", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.adapter.files.set("empty", Buffer.alloc(0));
    await kit.adapter.deliver(kit.adapter.message("봐 줘", { files: [{ fileRef: "empty", name: "빈.txt", mime: "text/plain", size: 0, kind: "file" }] }));
    await settle(kit);
    expect(kit.adapter.texts()).toContain("「빈.txt」은(는) 빈 파일이라 받지 않았습니다.");
  });

  it("removes files left in its own folders by a stop in the middle, when it starts (M7)", async () => {
    const kit = await startKit();
    for (const folder of ["incoming", "outgoing"]) {
      mkdirSync(join(kit.dataDir, "channels", folder, "answer-x"), { recursive: true });
      writeFileSync(join(kit.dataDir, "channels", folder, "left"), "left");
    }
    await kit.core.close();
    const again = openKit(kit.dir, kit.clock);
    await again.core.start();
    for (const folder of ["incoming", "outgoing"]) expect(readdirSync(join(kit.dataDir, "channels", folder))).toEqual([]);
    await again.core.close();
    expect(existsSync(join(kit.dataDir, "channels"))).toBe(true);
  });
});

describe("the block list (M4)", () => {
  const rules = { dataDir: "/home/me/.local/share/workbench", allowed: [] };
  it.each([
    ["/home/me/.claude.json"], ["/home/me/project/.mcp.json"], ["/home/me/.config/gh/hosts.yml"], ["/home/me/.yarnrc.yml"], ["/home/me/.vault-token"],
    ["/home/me/.config/rclone/rclone.conf"], ["/home/me/.config/google-chrome/Default/Login Data"], ["/home/me/.mozilla/firefox/x.default/logins.json"], ["/home/me/.mozilla/firefox/x.default/key4.db"],
    ["/home/me/.SSH/config"], ["/home/me/.Aws/credentials.txt"],
  ])("keeps %s out", (path) => {
    expect(blockedReason(path, path.split("/").at(-1)!, rules)).not.toBeNull();
  });

  it("lets an ordinary hosts.yml or Login notes go", () => {
    expect(blockedReason("/home/me/project/hosts.yml", "hosts.yml", rules)).toBeNull();
    expect(blockedReason("/home/me/project/Login notes.md", "Login notes.md", rules)).toBeNull();
  });
});

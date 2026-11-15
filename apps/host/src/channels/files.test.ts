import { mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blockedReason, namedFiles } from "./files.ts";
import { cleanKits, pair, press, say, settle, startKit, userItems, type Kit } from "./test-kit.ts";

// Files both ways: what the person sends becomes an attachment of the request; what the AI made
// comes back as attachments (a first-page picture with Office and Hangul documents, a long answer
// as a .md file); files that may hold a secret never go to the chat, and the chat is told.

afterEach(() => { vi.restoreAllMocks(); cleanKits(); });

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

/** A turn of the chat's conversation that ends with this answer, after `during` ran (the engine's work). */
async function turn(kit: Kit, answer: string, during: (sessionId: string, cwd: string) => void = () => undefined) {
  await say(kit, "일 하나");
  const { sessionId } = kit.engine.sent.at(-1)!;
  const cwd = kit.manager.workCwd(kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId);
  during(sessionId, cwd);
  kit.engine.say(sessionId, answer);
  kit.engine.finish(sessionId);
  await settle(kit);
  return { sessionId, cwd, answer: kit.adapter.last()! };
}

describe("files the person sends", () => {
  it("become attachments of the request, as the desktop's own attachment store keeps them", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.adapter.files.set("f-photo", PNG);
    await kit.adapter.deliver(kit.adapter.message("이거 표로 정리해 줘", { files: [{ fileRef: "f-photo", name: "photo-7.jpg", mime: "image/jpeg", size: PNG.length, kind: "photo" }] }));
    await settle(kit);
    const [sent] = kit.engine.sent;
    const item = userItems(kit, sent!.sessionId)[0]!;
    expect(item.text).toBe("이거 표로 정리해 줘");
    expect(item.attachments).toEqual([expect.objectContaining({ name: "photo-7.jpg", mime: "image/png", size: PNG.length })]);
    expect(readFileSync(kit.manager.attachments.path(item.attachments![0]!.id))).toEqual(PNG);
    // The download's temporary copy is gone.
    expect(readdirSync(kit.dataDir, { recursive: true }).filter((name) => String(name).includes("incoming") && !String(name).endsWith("incoming"))).toEqual([]);
    expect(kit.core.auditList().some((row) => row.action === "file.received" && row.result === "1")).toBe(true);
  });

  it("goes as a request also without words, and runs once when the messenger delivers it again", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.adapter.files.set("f-doc", Buffer.from("이름,학년\n홍길동,3\n"));
    const event = kit.adapter.message("", { eventId: "7001", files: [{ fileRef: "f-doc", name: "명단.csv", mime: "text/csv", size: 22, kind: "file" }] });
    await kit.adapter.deliver(event);
    await kit.adapter.deliver(event);
    await settle(kit);
    expect(kit.engine.sent).toHaveLength(1);
    expect(userItems(kit, kit.engine.sent[0]!.sessionId)[0]).toMatchObject({ text: "첨부한 파일을 봐 주세요.", attachments: [expect.objectContaining({ name: "명단.csv" })] });
  });

  it("says plainly when a file is over the size the bot may take, and sends the rest", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.adapter.files.set("f-small", Buffer.from("작은 파일"));
    await kit.adapter.deliver(kit.adapter.message("둘 다 봐 줘", { files: [
      { fileRef: "f-big", name: "녹화.mp4", mime: "video/mp4", size: 21 * 1024 * 1024, kind: "file" },
      { fileRef: "f-small", name: "메모.txt", mime: "text/plain", size: 13, kind: "file" },
    ] }));
    await settle(kit);
    expect(kit.adapter.texts()).toContain("「녹화.mp4」은(는) 20MB가 넘어 받지 못했습니다. 텔레그램 봇이 받을 수 있는 파일은 20MB까지입니다.");
    expect(userItems(kit, kit.engine.sent[0]!.sessionId)[0]!.attachments!.map((entry) => entry.name)).toEqual(["메모.txt"]);
  });

  it("says that a voice message is not taken yet, and runs nothing for it alone", async () => {
    const kit = await startKit();
    await pair(kit);
    await kit.adapter.deliver(kit.adapter.message("", { files: [{ fileRef: "f-voice", name: "voice-1", mime: "audio/ogg", size: 3000, kind: "voice" }] }));
    await settle(kit);
    expect(kit.adapter.texts().at(-1)).toBe("음성 메시지는 아직 받지 못합니다. 글로 적어 보내 주세요.");
    expect(kit.engine.sent).toEqual([]);
  });

  it("never writes a file's content to the channel's log or audit", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.adapter.files.set("f-secret", Buffer.from("안쪽 내용 0xDEADBEEF 고유문자열"));
    await kit.adapter.deliver(kit.adapter.message("봐 줘", { files: [{ fileRef: "f-secret", name: "내용.txt", mime: "text/plain", size: 40, kind: "file" }] }));
    await settle(kit);
    expect(kit.lines.join("\n")).not.toContain("0xDEADBEEF");
    expect(JSON.stringify(kit.core.auditList())).not.toContain("0xDEADBEEF");
    expect(kit.adapter.texts().join("\n")).not.toContain("0xDEADBEEF");
  });
});

describe("what the AI made comes back", () => {
  it("sends the documents the turn wrote, the pictures it showed and the files it named, each once", async () => {
    const kit = await startKit();
    await pair(kit);
    const { answer } = await turn(kit, "3학년 27명을 저장했습니다.\n파일: 명단-3학년.csv\n파일: ./명단-3학년.csv", (sessionId, cwd) => {
      writeFileSync(join(cwd, "명단-3학년.csv"), "이름\n");
      writeFileSync(join(cwd, "보고서.md"), "# 보고서\n");
      const tracked = kit.manager.openFile(kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId, "보고서.md");
      kit.manager.sink.upsertItem(sessionId, { kind: "artifact", id: "artifact:1", artifactId: tracked.id, revision: tracked.revision, change: "created", at: Date.now() });
      const picture = kit.manager.attachments.save(PNG, "screenshot.png", "image/png");
      kit.manager.sink.upsertItem(sessionId, { kind: "tool", id: "tool:1", tool: "command", title: "스크린숏", detail: null, output: null, status: "completed", at: Date.now(), images: [picture] });
      // The same picture shown again in a reply goes once.
      kit.manager.sink.upsertItem(sessionId, { kind: "assistant", id: "reply:media", text: "중간 보고", streaming: false, at: Date.now(), media: [{ source: "screenshot.png", attachment: picture }] });
    });
    expect(answer.out.text).toBe("3학년 27명을 저장했습니다.\n파일: 명단-3학년.csv\n파일: ./명단-3학년.csv");
    expect(answer.out.files!.map((file) => file.name).sort()).toEqual(["screenshot.png", "명단-3학년.csv", "보고서.md"].sort());
    expect(kit.adapter.uploads.map((file) => file.name).sort()).toEqual(["screenshot.png", "명단-3학년.csv", "보고서.md"].sort());
    expect(kit.adapter.uploads.find((file) => file.name === "보고서.md")!.bytes.toString("utf8")).toBe("# 보고서\n");
    expect(kit.core.auditList().some((row) => row.action === "file.sent" && row.result === "3")).toBe(true);
  });

  it("sends a picture the answer showed, and a drawing the turn made", async () => {
    const kit = await startKit();
    await pair(kit);
    await turn(kit, "그래프를 그렸습니다.", (sessionId, cwd) => {
      const chart = kit.manager.attachments.save(PNG, "그래프.png", "image/png");
      kit.manager.sink.upsertItem(sessionId, { kind: "assistant", id: "reply:media", text: "![그래프](그래프.png)", streaming: false, at: Date.now(), media: [{ source: "그래프.png", attachment: chart }] });
      writeFileSync(join(cwd, "표지.png"), PNG);
      const work = kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId;
      kit.manager.sink.upsertItem(sessionId, { kind: "image", id: "image:1", at: Date.now(), image: { id: "draw-1", workId: work, originSessionId: sessionId, drawSessionId: sessionId, status: "done", brief: "표지", template: null, aspect: "auto", transparent: false, prompt: "표지", revisedPrompt: null, path: join(cwd, "표지.png"), relPath: "표지.png", width: 1, height: 1, bytes: PNG.length, insertInto: null, error: null, createdAt: Date.now(), finishedAt: Date.now() } });
    });
    expect(kit.adapter.uploads.map((file) => file.name).sort()).toEqual(["그래프.png", "표지.png"]);
  });

  it("does not send a named file that was not changed during the turn, nor one outside the conversation's folder (and says so)", async () => {
    const kit = await startKit();
    await pair(kit);
    await say(kit, "준비");
    const first = kit.engine.sent[0]!.sessionId;
    kit.engine.finish(first);
    await settle(kit);
    const cwd = kit.manager.workCwd(kit.manager.snapshot().works[0]!.id);
    const old = join(cwd, "예전 파일.txt");
    writeFileSync(old, "x");
    utimesSync(old, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    const outside = join(kit.dataDir, "..", "밖의 파일.txt");
    const { answer } = await turn(kit, `정리했습니다.\n파일: 예전 파일.txt\n파일: ${outside}`, () => writeFileSync(outside, "y"));
    expect(answer.out.files ?? []).toEqual([]);
    expect(answer.out.text).toContain("「밖의 파일.txt」은(는) 대화의 작업 폴더 밖에 있어 보내지 않았습니다.");
  });

  it("keeps secret-bearing files out of the chat, says so, and judges the real file behind a link", async () => {
    const kit = await startKit();
    await pair(kit);
    const { answer } = await turn(kit, "설정을 만들었습니다.\n파일: .env\n파일: 열쇠.txt\n파일: 설명.md", (_sessionId, cwd) => {
      writeFileSync(join(cwd, ".env"), "API_KEY=sk-test\n");
      mkdirSync(join(cwd, ".ssh"), { recursive: true });
      writeFileSync(join(cwd, ".ssh", "id_ed25519"), "PRIVATE");
      symlinkSync(join(cwd, ".ssh", "id_ed25519"), join(cwd, "열쇠.txt"));
      writeFileSync(join(cwd, "설명.md"), "# 설명\n");
    });
    expect(answer.out.files!.map((file) => file.name)).toEqual(["설명.md"]);
    expect(answer.out.text).toContain("「.env」, 「열쇠.txt」은(는) 비밀이 들어 있을 수 있어 보내지 않았습니다.");
    expect(kit.adapter.uploads.map((file) => file.bytes.toString("utf8")).join("")).not.toContain("PRIVATE");
    expect(kit.core.auditList().some((row) => row.action === "file.blocked" && row.result === "2")).toBe(true);
  });

  it("sends a long answer's opening, with the whole answer as a .md file instead of a button", async () => {
    const kit = await startKit();
    await pair(kit);
    const body = Array.from({ length: 12 }, (_, index) => `${index + 1}번째 문단입니다. ${"내용 ".repeat(30)}`).join("\n\n");
    const { answer } = await turn(kit, body);
    expect(answer.out.text.length).toBeLessThan(1000);
    expect(answer.out.text).toMatch(/\(답이 길어 앞부분만 보냈습니다\. 전체는 첨부한 파일에 있습니다\.\)$/);
    expect(answer.out.buttons ?? []).toEqual([]);
    const file = kit.adapter.uploads.find((entry) => entry.name.endsWith(".md"))!;
    expect(file.name).toMatch(/^휴대폰 · \d+-\d+ 답\.md$/);
    expect(file.bytes.toString("utf8")).toBe(body.trim());
    // The temporary file is gone once it went.
    expect(readdirSync(join(kit.dataDir, "channels", "outgoing"))).toEqual([]);
  });

  it("hides secrets in the long answer's file and in the names of the files it sends", async () => {
    const kit = await startKit();
    await pair(kit);
    const token = "7000000001:AAF" + "k".repeat(8) + "-Fake_token-for-loopback-01";
    const body = `${"긴 답 ".repeat(400)}\n\n토큰: ${token}\n파일: 키-${token}.txt`;
    await turn(kit, body, (_sessionId, cwd) => writeFileSync(join(cwd, `키-${token}.txt`), "평범한 내용"));
    const file = kit.adapter.uploads.find((entry) => entry.name.endsWith(".md"))!;
    expect(file.bytes.toString("utf8")).not.toContain(token);
    expect(file.bytes.toString("utf8")).toContain("[");
    // A file whose name carries a secret goes, without the secret in its name.
    const named = kit.adapter.uploads.find((entry) => entry.name.startsWith("키-"))!;
    expect(named.bytes.toString("utf8")).toBe("평범한 내용");
    expect(named.name).not.toContain(token);
  });

  it("sends an Office or Hangul document with a picture of its first page", async () => {
    const kit = await startKit();
    const rendered: string[] = [];
    kit.core.preview = async (artifact) => {
      rendered.push(artifact.name);
      const file = join(kit.dataDir, `${artifact.id}-p1.png`);
      writeFileSync(file, PNG);
      return file;
    };
    await pair(kit);
    await turn(kit, "강의계획서 초안을 만들었습니다.", (sessionId, cwd) => {
      writeFileSync(join(cwd, "2026-2 강의계획서.hwpx"), "PK fake");
      const tracked = kit.manager.openFile(kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId, "2026-2 강의계획서.hwpx");
      kit.manager.sink.upsertItem(sessionId, { kind: "artifact", id: "artifact:1", artifactId: tracked.id, revision: tracked.revision, change: "created", at: Date.now() });
    });
    expect(rendered).toEqual(["2026-2 강의계획서.hwpx"]);
    expect(kit.adapter.uploads.map((file) => [file.name, file.caption ?? null])).toEqual([["2026-2 강의계획서.hwpx", null], ["2026-2 강의계획서 1쪽.png", "1쪽 미리보기 · 2026-2 강의계획서.hwpx"]]);
  });

  it("sends the answer without the picture when the first page cannot be drawn on this PC, and says so", async () => {
    const kit = await startKit();
    kit.core.preview = async () => { throw new Error("이음오피스를 찾지 못해 미리보기를 만들 수 없습니다."); };
    await pair(kit);
    const { answer } = await turn(kit, "만들었습니다.", (sessionId, cwd) => {
      writeFileSync(join(cwd, "표.xlsx"), "PK fake");
      const tracked = kit.manager.openFile(kit.manager.snapshot().sessions.find((entry) => entry.id === sessionId)!.workId, "표.xlsx");
      kit.manager.sink.upsertItem(sessionId, { kind: "artifact", id: "artifact:1", artifactId: tracked.id, revision: tracked.revision, change: "created", at: Date.now() });
    });
    expect(answer.out.files!.map((file) => file.name)).toEqual(["표.xlsx"]);
    expect(answer.out.text).toContain("「표.xlsx」의 1쪽 미리보기는 이 PC에서 만들지 못했습니다.");
  });

  it("does not send a file twice when the answer is tried again", async () => {
    const kit = await startKit();
    await pair(kit);
    kit.adapter.failures.push("no");
    await turn(kit, "만들었습니다.\n파일: 결과.txt", (_sessionId, cwd) => writeFileSync(join(cwd, "결과.txt"), "결과"));
    await settle(kit);
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["결과.txt"]);
    expect(kit.adapter.sent.filter((entry) => entry.out.files?.length)).toHaveLength(1);
  });

  it("sends nothing of the files to a chat that was paused meanwhile, and sends them once on resume", async () => {
    const kit = await startKit();
    const binding = await pair(kit);
    await say(kit, "일 하나");
    const { sessionId } = kit.engine.sent[0]!;
    const cwd = kit.manager.workCwd(kit.manager.snapshot().works[0]!.id);
    writeFileSync(join(cwd, "결과.txt"), "결과");
    kit.core.pause(binding.id, true);
    kit.engine.say(sessionId, "끝냈습니다.\n파일: 결과.txt");
    kit.engine.finish(sessionId);
    await settle(kit);
    expect(kit.adapter.uploads).toEqual([]);
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(kit.adapter.uploads.map((file) => file.name)).toEqual(["결과.txt"]);
  });
});

describe("a recent file from the menu", () => {
  it("is sent on 받기 and drawn on 1쪽 보기; a secret-bearing one is not", async () => {
    const kit = await startKit();
    kit.core.preview = async (artifact) => { const file = join(kit.dataDir, "p.png"); writeFileSync(file, PNG); return artifact ? file : null; };
    await pair(kit);
    await say(kit, "첫 일");
    kit.engine.finish(kit.engine.sent[0]!.sessionId);
    await settle(kit);
    const work = kit.manager.snapshot().works[0]!;
    writeFileSync(join(work.cwd, "예산표.xlsx"), "PK budget");
    kit.manager.openFile(work.id, "예산표.xlsx");
    await say(kit, "메뉴");
    await press(kit, "최근 파일");
    await press(kit, "예산표.xlsx");
    await press(kit, "받기");
    expect(kit.adapter.uploads.at(-1)).toMatchObject({ name: "예산표.xlsx" });
    expect(kit.adapter.uploads.at(-1)!.bytes.toString("utf8")).toBe("PK budget");
    await press(kit, "1쪽 보기");
    expect(kit.adapter.uploads.at(-1)).toMatchObject({ name: "예산표 1쪽.png", caption: "1쪽 미리보기 · 예산표.xlsx" });
    // A document kept in a credentials folder is not sent.
    mkdirSync(join(work.cwd, ".ssh"), { recursive: true });
    writeFileSync(join(work.cwd, ".ssh", "메모.md"), "비밀 메모");
    kit.manager.openFile(work.id, join(work.cwd, ".ssh", "메모.md"));
    const uploads = kit.adapter.uploads.length;
    await say(kit, "메뉴");
    await press(kit, "최근 파일");
    await press(kit, "메모.md");
    await press(kit, "받기");
    expect(kit.adapter.uploads).toHaveLength(uploads);
    expect(kit.adapter.texts().at(-1)).toBe("「메모.md」은(는) 비밀이 들어 있을 수 있어 보내지 않았습니다.");
  });
});

describe("the block list", () => {
  const rules = (dataDir: string) => ({ dataDir, allowed: [join(dataDir, "works"), join(dataDir, "attachments")] });
  it.each([
    [".env"], [".env.local"], ["production.env"], ["server.pem"], ["tls.key"], ["id_rsa"], ["id_ed25519"], [".npmrc"], [".netrc"], [".git-credentials"],
    ["credentials.json"], ["secrets.yaml"], ["client_secret_123.json"], ["store.kdbx"], ["cert.p12"],
  ])("keeps %s out", (name) => {
    expect(blockedReason(`/home/me/project/${name}`, name, rules("/home/me/.local/share/workbench"))).not.toBeNull();
  });

  it.each([["보고서.md"], ["명단.csv"], ["environment.md"], ["keynote.pptx"], ["monkey.png"], ["id_rsa.pub.txt"]])("lets %s go", (name) => {
    expect(blockedReason(`/home/me/project/${name}`, name, rules("/home/me/.local/share/workbench"))).toBeNull();
  });

  it("keeps out what is inside credential folders and the app's own data folder, except its project folders and attachments", () => {
    const data = "/home/me/.local/share/workbench";
    expect(blockedReason("/home/me/.ssh/config", "config", rules(data))).toBe("secret-folder");
    expect(blockedReason("/home/me/.aws/config", "config", rules(data))).toBe("secret-folder");
    expect(blockedReason(`${data}/state.sqlite`, "state.sqlite", rules(data))).toBe("app-data");
    expect(blockedReason(`${data}/channels/bots.json`, "bots.json", rules(data))).toBe("app-data");
    expect(blockedReason(`${data}/works/abc/보고서.md`, "보고서.md", rules(data))).toBeNull();
    expect(blockedReason(`${data}/attachments/ab.png`, "ab.png", rules(data))).toBeNull();
  });

  it("reads 파일: lines however they are listed", () => {
    expect(namedFiles("결과\n파일: a.txt\n- 파일: 「b c.md」\n· 첨부 파일：/x/y.pdf\n파일이 많습니다")).toEqual(["a.txt", "b c.md", "/x/y.pdf"]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { Attachment } from "@workbench/contracts";
import { retryRefusal } from "./comfort.ts";
import { cleanKits, pair, press, say, sessionOf, settle, startKit, userItems, type Kit } from "./test-kit.ts";

// Unit 14: answers that read well, the app saying what it knows (status, footer, the preamble's
// model line), and the everyday words (다시 시도, 이름 바꾸기, 맥락 줄이기, 도움말, slash commands) —
// each through the desktop's own functions and behind the channel's gates.

afterEach(() => { cleanKits(); });

const MODELS = { models: [{ id: "claude-opus-9", label: "Opus", description: null, resolvedModel: null, efforts: ["low", "high"], defaultEffort: "high", isDefault: true }], usage: [{ label: "5시간", usedPercent: 34, resetsAt: null }], usageObservedAt: null };

async function chat(options: { footer?: boolean; codex?: boolean } = {}) {
  const kit = await startKit({ footer: options.footer ?? true, ...(options.codex ? { codex: true } : {}) });
  kit.engine.report = MODELS;
  await pair(kit);
  return kit;
}

/** A turn of the chat, answered and ended; its conversation. */
async function turn(kit: Kit, line: string, answer: string, context?: { used: number; window: number | null }) {
  await say(kit, line);
  const sessionId = kit.engine.sent.at(-1)!.sessionId;
  // Reported during the turn (the conversation's record is stamped by the wall clock).
  if (context) kit.manager.sink.updateSession(sessionId, { context: { ...context, compactAt: null, at: Date.now() } });
  kit.engine.say(sessionId, answer);
  kit.engine.finish(sessionId);
  await settle(kit);
  return sessionId;
}

const last = (kit: Kit) => kit.adapter.last()!;
const audits = (kit: Kit, action: string) => kit.core.auditList().filter((row) => row.action === action);

describe("answers that read well", () => {
  it("sends an answer's markdown as readable text with marks, never the stars", async () => {
    const kit = await chat({ footer: false });
    await turn(kit, "뭘 할 수 있어?", "**GPT-6 기반 Codex 에이전트**입니다.\n\n- **개발:** 코드\n- `my_file.py`");
    const { out } = last(kit);
    expect(out.text).toBe("GPT-6 기반 Codex 에이전트입니다.\n\n• 개발: 코드\n• my_file.py");
    expect(out.markdown).toBeUndefined();
    expect(out.marks?.map((mark) => out.text.slice(mark.offset, mark.offset + mark.length))).toEqual(["GPT-6 기반 Codex 에이전트", "개발:", "my_file.py"]);
  });

  it("redacts before formatting, and reads the formatted text again: a value split by markup does not leave", async () => {
    const kit = await chat({ footer: false });
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
    await turn(kit, "키 보여 줘", `키는 ${secret.slice(0, 12)}**${secret.slice(12)}** 입니다.`);
    expect(last(kit).out.text).not.toContain(secret);
    expect(last(kit).out.text).toContain("[API 키]");
    // Hidden only once readable: it goes plain, no mark survives over changed text.
    expect(last(kit).out.marks).toBeUndefined();
  });

  it("marks lie over the same words after a value was hidden ahead of them", async () => {
    const kit = await chat({ footer: false });
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
    await turn(kit, "키 보여 줘", `키는 ${secret} 이고 **굵게** 와 \`코드\` 입니다.`);
    const { out } = last(kit);
    expect(out.text).toBe("키는 [API 키] 이고 굵게 와 코드 입니다.");
    expect(out.marks?.map((mark) => out.text.slice(mark.offset, mark.offset + mark.length))).toEqual(["굵게", "코드"]);
  });

  it("adds what the channel says under an answer as plain text, never read as markdown", async () => {
    const kit = await chat();
    kit.engine.report = { ...MODELS, models: [{ ...MODELS.models[0]!, id: "gpt_x*1*" }] };
    await turn(kit, "일", "끝났습니다.");
    expect(last(kit).out.text).toBe("끝났습니다.\n\nClaude · gpt_x*1* · 0:00");
  });

  it("closes a code block the cut left open: the cut note and the footer sit under it, plain, without backslashes", async () => {
    const kit = await chat();
    kit.engine.report = { ...MODELS, models: [{ ...MODELS.models[0]!, id: "gpt-5.1" }] };
    const code = Array.from({ length: 40 }, (_, index) => `def step_${index}():\n    return ${index}`).join("\n\n");
    await turn(kit, "코드 보여 줘", `고친 코드입니다.\n\n\`\`\`python\n${code}\n\`\`\`\n\n끝.`);
    const { out } = last(kit);
    const note = "(답이 길어 앞부분만 보냈습니다. 전체는 첨부한 파일에 있습니다.)";
    expect(out.text.endsWith(`\n\n${note}\n\nClaude · gpt-5.1 · 0:00`)).toBe(true);
    expect(out.text).not.toContain("\\");
    const under = out.text.indexOf(note);
    const pre = out.marks?.filter((mark) => mark.type === "pre") ?? [];
    expect(pre).toHaveLength(1);
    expect(pre[0]!.offset + pre[0]!.length).toBeLessThan(under);
    expect(out.marks?.every((mark) => mark.offset + mark.length <= under)).toBe(true);
  });
});

describe("the app answers what the app knows", () => {
  it("상태 names the conversation, engine, exact model id, effort, access, context use, the provider's limits and the queue", async () => {
    const kit = await chat();
    const sessionId = await turn(kit, "첫 일", "끝", { used: 43_000, window: 128_000 });
    kit.manager.sink.updateSession(sessionId, { engineModel: "claude-opus-9-20261101" });
    await say(kit, "상태");
    expect(last(kit).out.text).toBe([
      `지금: 「휴대폰」 › 「${sessionOf(kit, sessionId).purpose}」`,
      "엔진: Claude · 모델 claude-opus-9 · 엔진 기본값",
      "노력: 높음 (high) · 기본값",
      "지난 답의 모델: claude-opus-9-20261101",
      "접근: 전체 접근 · 묻지 않음",
      "맥락: 34% 사용 (43k / 128k 토큰)",
      "사용량: 5시간 34%",
      "쉬는 중",
    ].join("\n"));
    // /status is the same.
    await say(kit, "/status");
    expect(last(kit).out.text).toContain("엔진: Claude · 모델 claude-opus-9");
  });

  it("says nothing about context share when the engine gave no window, and nothing at all when it reported nothing", async () => {
    const kit = await chat();
    const sessionId = await turn(kit, "첫 일", "끝");
    await say(kit, "상태");
    expect(last(kit).out.text).not.toContain("맥락");
    kit.manager.sink.updateSession(sessionId, { context: { used: 12_345, window: null, compactAt: null, at: kit.clock.now } });
    await say(kit, "상태");
    expect(last(kit).out.text).toContain("맥락: 12k 토큰 사용 (엔진이 맥락 크기를 알리지 않았습니다)");
    expect(last(kit).out.text).not.toMatch(/맥락: \d+%/);
  });

  it("tells the engine its model and effort in the phone preamble, so it need not guess", async () => {
    const kit = await chat();
    await say(kit, "어떤 모델이야?");
    expect(kit.engine.sent.at(-1)!.text).toContain("이 대화는 Workbench에서 Claude로 실행됩니다. 모델: claude-opus-9 · 엔진 기본값. 노력: 높음 (high) · 기본값.");
    // The conversation keeps only the person's words.
    expect(userItems(kit, kit.engine.sent.at(-1)!.sessionId).at(-1)!.text).toBe("어떤 모델이야?");
    expect(userItems(kit, kit.engine.sent.at(-1)!.sessionId).at(-1)!.origin?.context).toBe(4);
  });
});

describe("the footer under a finished answer", () => {
  it("is on by default: engine · model · time · context share reported during this turn; never on the progress line", async () => {
    const kit = await chat();
    await turn(kit, "일", "끝났습니다.", { used: 34_000, window: 100_000 });
    expect(last(kit).out.text).toBe("끝났습니다.\n\nClaude · claude-opus-9 · 0:00 · 맥락 34%");
    expect(kit.adapter.edits.every((edit) => !edit.out.text.includes("claude-opus-9"))).toBe(true);
  });

  it("reads the model and context of the turn that answered, also when the answer is held and sent after a later change", async () => {
    const kit = await chat();
    const binding = kit.core.bindings()[0]!;
    await say(kit, "일");
    const sessionId = kit.engine.sent.at(-1)!.sessionId;
    kit.manager.sink.updateSession(sessionId, { engineModel: "claude-opus-9-a", context: { used: 20, window: 100, compactAt: null, at: Date.now() } });
    kit.core.pause(binding.id, true);
    kit.engine.say(sessionId, "끝났습니다.");
    kit.engine.finish(sessionId);
    await settle(kit);
    // Later, while the answer waits: another model, a newer context figure.
    await new Promise((done) => setTimeout(done, 5));
    kit.manager.sink.updateSession(sessionId, { engineModel: "claude-opus-9-b", context: { used: 90, window: 100, compactAt: null, at: Date.now() } });
    kit.core.pause(binding.id, false);
    await settle(kit);
    expect(kit.adapter.texts().filter((text) => text.startsWith("끝났습니다."))).toEqual(["끝났습니다.\n\nClaude · claude-opus-9-a · 0:00"]);
  });

  it("leaves out a context figure older than the turn", async () => {
    const kit = await chat();
    const sessionId = await turn(kit, "일", "하나");
    kit.manager.sink.updateSession(sessionId, { context: { used: 1, window: 10, compactAt: null, at: Date.now() - 60_000 } });
    await turn(kit, "둘째", "둘");
    expect(last(kit).out.text).toBe("둘\n\nClaude · claude-opus-9 · 0:00");
  });

  it("is turned off and on by words and from [알림], and is not on failures", async () => {
    const kit = await chat();
    await say(kit, "꼬리말 끄기");
    await turn(kit, "일", "끝났습니다.");
    expect(last(kit).out.text).toBe("끝났습니다.");
    await say(kit, "메뉴");
    await press(kit, "알림");
    await press(kit, "꺼짐 · 답 아래 꼬리말(모델·시간·맥락)");
    expect(kit.adapter.buttonOf("켜짐 · 답 아래 꼬리말(모델·시간·맥락)")).toBeTruthy();
    await turn(kit, "둘째", "둘");
    expect(last(kit).out.text).toBe("둘\n\nClaude · claude-opus-9 · 0:00");
    // Newest first.
    expect(audits(kit, "footer").map((row) => row.result)).toEqual(["on", "off"]);
    await say(kit, "셋째");
    kit.engine.finish(kit.engine.sent.at(-1)!.sessionId, "failed");
    await settle(kit);
    expect(last(kit).out.text).not.toContain("claude-opus-9");
  });
});

describe("다시 시도", () => {
  it("sends the last request again as a new turn, with its files by reference, through the guarded send", async () => {
    const kit = await chat({ footer: false });
    const file: Attachment = kit.manager.attachments.save(Buffer.from("hello"), "a.txt", "text/plain");
    await turn(kit, "명단 정리해 줘", "정리했습니다.");
    const session = kit.engine.sent.at(-1)!.sessionId;
    const bindingId = kit.core.bindings()[0]!.id;
    // A request with a file, sent from this chat, is the last one.
    await kit.manager.send(session, "ch:phone-1", "이 파일도 봐 줘", [], null, null, "auto", { attachments: [file], origin: { channel: "telegram", bindingId } });
    kit.engine.finish(session);
    await settle(kit);
    await say(kit, "다시 시도");
    expect(kit.engine.sent.at(-1)!.text.endsWith("이 파일도 봐 줘")).toBe(true);
    const retried = userItems(kit, session).at(-1)!;
    expect(retried).toMatchObject({ text: "이 파일도 봐 줘", origin: { bindingId } });
    expect(retried.attachments?.map((entry) => entry.id)).toEqual([file.id]);
    expect(kit.adapter.texts()).toContain("다시 보냅니다: “이 파일도 봐 줘”");
    expect(audits(kit, "retry")).toHaveLength(1);
    expect(JSON.stringify(audits(kit, "retry"))).not.toContain("파일");
  });

  it("repeats a 계획 먼저 request as a plan again, never as work to do", async () => {
    const kit = await chat({ footer: false });
    await turn(kit, "계획 먼저: 지난 학기 파일 정리해 줘", "계획입니다.");
    const session = kit.engine.sent.at(-1)!.sessionId;
    expect(userItems(kit, session).at(-1)).toMatchObject({ text: "지난 학기 파일 정리해 줘", plan: true });
    await say(kit, "다시 시도");
    const items = userItems(kit, session);
    expect(items).toHaveLength(2);
    expect(items.at(-1)).toMatchObject({ text: "지난 학기 파일 정리해 줘", plan: true });
  });

  it("refuses with one line, and sends nothing, when the last request was not typed in this chat", async () => {
    const kit = await chat({ footer: false });
    const session = await turn(kit, "명단 정리해 줘", "정리했습니다.");
    await kit.manager.send(session, "pc-1", "PC에서만 한 일", []);
    kit.engine.finish(session);
    await settle(kit);
    const asked = kit.engine.sent.length;
    await say(kit, "다시 시도");
    expect(kit.engine.sent).toHaveLength(asked);
    expect(last(kit).out.text).toBe("마지막 요청은 이 채팅에서 보낸 것이 아니라 다시 보내지 않습니다. 필요한 말을 새로 적어 보내 주세요.");
    expect(audits(kit, "retry").map((row) => row.result)).toEqual(["refused"]);
  });

  it("never repeats a continuation, a schedule's run, or a request whose documents, target or relay cannot go again", () => {
    const base = { kind: "user" as const, id: "user:ch:1", text: "일", at: 1, origin: { channel: "telegram" as const, bindingId: "b1" } };
    expect(retryRefusal(base, "b1")).toBeNull();
    expect(retryRefusal({ ...base, plan: true, attachments: [] }, "b1")).toBeNull();
    for (const item of [
      { ...base, id: "user:cont:h1" }, { ...base, scheduled: true }, { ...base, origin: undefined }, { ...base, origin: { ...base.origin, bindingId: "b2" } },
      { ...base, refs: [{ artifactId: "a", revision: 1, title: "문서" }] as never }, { ...base, create: { path: "x.md" } as never }, { ...base, from: { sessionId: "s", label: "다른" } },
      { ...base, link: {} as never },
    ]) expect(retryRefusal(item, "b1")).toEqual(expect.any(String));
  });

  it("only while the conversation rests; /retry is the same word", async () => {
    const kit = await chat({ footer: false });
    await say(kit, "첫 일");
    const asked = kit.engine.sent.length;
    await say(kit, "/retry");
    expect(last(kit).out.text).toBe("일하는 중이라 다시 보내지 않았습니다. 끝난 뒤에 '다시 시도'를 보내 주세요.");
    expect(kit.engine.sent).toHaveLength(asked);
    expect(kit.engine.steered).toHaveLength(0);
  });

  it("refuses an archived conversation as everywhere", async () => {
    const kit = await chat({ footer: false });
    const session = await turn(kit, "첫 일", "끝");
    kit.manager.updateSession(session, { archived: true });
    const asked = kit.engine.sent.length;
    await say(kit, "다시 시도");
    expect(kit.engine.sent).toHaveLength(asked);
    expect(kit.adapter.texts().at(-1)).toBe("이 대화는 보관되어 더 보낼 수 없습니다. '새 대화'라고 보내면 새 대화로 옮깁니다.");
  });
});

describe("대화 이름 바꾸기", () => {
  it("takes one line through the desktop's own rename; over-long or several lines are refused and the input stays", async () => {
    const kit = await chat({ footer: false });
    const session = await turn(kit, "첫 일", "끝");
    await say(kit, "대화 이름 바꾸기");
    expect(last(kit).out.text).toMatch(/의 새 이름을 적어 보내 주세요\(한 줄, 60자까지\)\.$/);
    await say(kit, "가".repeat(61));
    expect(last(kit).out.text).toBe("대화 이름은 한 줄로 60자까지입니다(지금 61자). 바꾸지 않았습니다. 짧게 다시 보내거나 [취소]를 누르세요.");
    await say(kit, "첫 줄\n둘째 줄");
    expect(last(kit).out.text).toMatch(/^대화 이름은 한 줄로/);
    const asked = kit.engine.sent.length;
    await say(kit, "예산 정리");
    expect(sessionOf(kit, session).purpose).toBe("예산 정리");
    expect(sessionOf(kit, session).purposeSource).toBe("user");
    expect(last(kit).out.text).toBe("대화 이름을 「예산 정리」(으)로 바꿨습니다.");
    expect(kit.engine.sent).toHaveLength(asked);
    expect(JSON.stringify(audits(kit, "rename"))).not.toContain("예산");
  });

  it("is closed by a command, and lines after it go to the AI again", async () => {
    const kit = await chat({ footer: false });
    await turn(kit, "첫 일", "끝");
    await say(kit, "/rename");
    await say(kit, "도움말");
    const asked = kit.engine.sent.length;
    await say(kit, "새 이름 아님");
    expect(kit.engine.sent).toHaveLength(asked + 1);
  });

  it("from the status screen's button too", async () => {
    const kit = await chat({ footer: false });
    const session = await turn(kit, "첫 일", "끝");
    await say(kit, "상태");
    await press(kit, "이름 바꾸기");
    await say(kit, "버튼으로 바꾼 이름");
    expect(sessionOf(kit, session).purpose).toBe("버튼으로 바꾼 이름");
  });
});

describe("맥락 줄이기", () => {
  it("uses the desktop's own compaction for either engine, and says the desktop's reason when there is nothing to compact", async () => {
    const kit = await chat({ footer: false, codex: true });
    const claudeSession = await turn(kit, "첫 일", "끝");
    kit.manager.sink.updateSession(claudeSession, { nativeSessionId: "native-claude" });
    // An engine without a compaction (the stand-in here): the desktop's own reason, never a claim about the engine.
    await say(kit, "맥락 줄이기");
    expect(last(kit).out.text).toBe("줄이지 못했습니다: 아직 압축할 대화가 없습니다.");
    const compacted: string[] = [];
    // Claude Code's own /compact (providers/claude.ts compact) goes the same way.
    Object.assign(kit.engine, { compact: async (session: { id: string }) => { compacted.push(session.id); return true; } });
    await say(kit, "맥락 줄이기");
    expect(compacted).toEqual([claudeSession]);
    Object.assign(kit.codex!, { compact: async (session: { id: string }) => { compacted.push(session.id); return true; } });
    await say(kit, "메뉴");
    await press(kit, "엔진·모델");
    await press(kit, "Codex");
    await say(kit, "코덱스 일");
    const codexSession = kit.codex!.sent.at(-1)!.sessionId;
    kit.codex!.say(codexSession, "끝");
    kit.codex!.finish(codexSession);
    await settle(kit);
    kit.manager.sink.updateSession(codexSession, { nativeSessionId: "thread-1" });
    await say(kit, "/compact");
    expect(compacted).toEqual([claudeSession, codexSession]);
    expect(last(kit).out.text).toBe("맥락을 줄이기 시작했습니다. 끝나면 '상태'에서 맥락이 줄어든 것을 볼 수 있습니다.");
    expect(audits(kit, "compact").map((row) => row.result)).toEqual(["started", "started", "nothing_to_compact"]); // newest first
  });
});

describe("help and slash commands", () => {
  it("/help and 도움말 give one short message; /chats, /model, /usage open the menu's own screens", async () => {
    const kit = await chat({ footer: false });
    await turn(kit, "첫 일", "끝");
    await say(kit, "/help");
    const help = last(kit).out.text;
    expect(help).toMatch(/^그냥 적어 보내면 지금 대화의 AI에게 갑니다/);
    expect(help).toContain("/menu /new /chats /model /status /usage /retry /stop /help");
    expect(help.length).toBeLessThan(700);
    await say(kit, "도움말");
    expect(last(kit).out.text).toBe(help);
    await say(kit, "/chats");
    expect(last(kit).out.text).toMatch(/의 최근 대화$/);
    await say(kit, "/model@wb_7k3q9x_bot");
    expect(last(kit).out.text).toMatch(/^지금: Claude/);
    await say(kit, "/usage");
    expect(last(kit).out.text).toMatch(/^Claude\n· 5시간: 34% 사용/);
    expect(kit.engine.sent).toHaveLength(1);
  });

  it("a lone unknown slash word gets one line pointing to /help and never reaches the AI", async () => {
    const kit = await chat({ footer: false });
    await say(kit, "/foo");
    await say(kit, "/foo@wb_7k3q9x_bot");
    expect(kit.adapter.texts().slice(-2)).toEqual(["모르는 명령입니다. /help 를 보내면 쓸 수 있는 말이 나옵니다.", "모르는 명령입니다. /help 를 보내면 쓸 수 있는 말이 나옵니다."]);
    expect(kit.engine.sent).toHaveLength(0);
  });

  it("any other line that starts with / is for the AI: a top-level path with words after it, a command word with words after it", async () => {
    const kit = await chat({ footer: false });
    const lines = ["/tmp 폴더 정리해 줘", "/data 아래 csv 합쳐 줘", "/usr/bin 에 뭐가 있어?", "/home/me/a.txt", "/model gpt-9"];
    for (const line of lines) await say(kit, line);
    expect(kit.adapter.texts().filter((text) => text.startsWith("모르는 명령"))).toEqual([]);
    expect(kit.engine.sent.map((entry) => entry.text.split("\n").at(-1))).toEqual(expect.arrayContaining(["/tmp 폴더 정리해 줘"]));
    expect(userItems(kit, kit.engine.sent[0]!.sessionId).map((item) => item.text)).toEqual(lines);
  });
});

describe("the gates hold for everything added", () => {
  it("paused or locked: every new word gets only the short reply, and nothing acts", async () => {
    const kit = await chat();
    const session = await turn(kit, "첫 일", "끝");
    const binding = kit.core.bindings()[0]!;
    kit.core.pause(binding.id, true);
    for (const word of ["다시 시도", "/help", "대화 이름 바꾸기", "맥락 줄이기", "꼬리말 끄기", "/foo", "/status"]) await say(kit, word);
    expect(kit.adapter.texts().slice(-7)).toEqual(Array(7).fill("지금은 PC에서 채널을 멈춰 두었습니다."));
    kit.core.pause(binding.id, false);
    await settle(kit);
    kit.core.lock(binding.id);
    await settle(kit);
    for (const word of ["/retry", "도움말"]) await say(kit, word);
    expect(kit.adapter.texts().slice(-2)).toEqual(Array(2).fill("채널이 잠겨 있습니다. PC에서만 풀 수 있습니다."));
    expect(kit.engine.sent).toHaveLength(1);
    expect(sessionOf(kit, session).purpose).not.toBe("다시 시도");
    expect(audits(kit, "footer")).toHaveLength(0);
  });

  it("a stranger gets nothing of it (default deny), a group nothing at all", async () => {
    const kit = await chat();
    const before = kit.adapter.sent.length;
    await say(kit, "/help", { userId: "999" });
    await say(kit, "다시 시도", { userId: "999" });
    expect(kit.adapter.sent.slice(before).map((entry) => entry.out.text)).toEqual(["이 봇은 개인용입니다."]);
    expect(kit.engine.sent).toHaveLength(0);
  });

  it("every line it sends passes the redactor (status, footer, help)", async () => {
    const kit = await chat();
    const secret = "claude-opus-9-secret-build";
    kit.engine.report = { ...MODELS, models: [{ ...MODELS.models[0]!, id: secret }] };
    kit.redactor.add("시험", secret);
    await turn(kit, "일", "끝");
    await say(kit, "상태");
    for (const text of kit.adapter.texts()) expect(text).not.toContain(secret);
    expect(kit.adapter.texts().join("\n")).toContain("[비밀: 시험]");
  });
});

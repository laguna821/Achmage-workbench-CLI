import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialService, HANDOFF_TTL, continuationText } from "../credentials/service.ts";
import { installScrubber } from "../credentials/install.ts";
import { formsOf } from "../credentials/forms.ts";
import { OfficeVault } from "../office-vault.ts";
import { cleanKits, pair, press, say, settle, startKit, until, userItems, type Kit } from "./test-kit.ts";
import { ChannelLog } from "./log.ts";
import { VaultChat, VaultRedactor } from "./vault-chat.ts";

// The credential store in the paired chat (unit 7): the hand-over message, the continuation as a
// request of the chat, 매번 묻기, and "비밀 보관함". Made-up values only.
const PASSWORD = "zz-secret-pass-0006";

afterEach(() => cleanKits());

async function vaultKit(options: { input?: boolean } = {}) {
  const kit = await startKit();
  const vault = new OfficeVault(kit.dataDir, async () => ({ id: "c".repeat(32), key: Buffer.alloc(32, 7) }));
  const service = new CredentialService({ dataDir: kit.dataDir, vault, manager: kit.manager, now: () => kit.clock.now });
  installScrubber(kit.store, kit.manager, service.scrubber);
  const chat = new VaultChat({ service, manager: kit.manager, now: () => kit.clock.now, ...(options.input ? { store: kit.store } : {}) });
  kit.core.use(chat);
  const binding = await pair(kit);
  await say(kit, "도서관 대출 목록 정리해 줘");
  const sessionId = kit.core.bindings()[0]!.pointerSessionId!;
  return { ...kit, service, chat, binding, sessionId };
}
type VaultKit = Awaited<ReturnType<typeof vaultKit>>;
const NEED = ["need", "--name", "학술정보원", "--kind", "login", "--site", "lib.example.ac.kr", "--fields", "아이디,비밀번호"];
const continued = (kit: Kit) => kit.engine.sent.filter((entry) => entry.text.includes("가 준비되었습니다. 멈춘 곳에서 이어 하세요."));
const sentWith = (kit: Kit, part: string) => kit.adapter.sent.findLast((entry) => entry.out.text.includes(part))!;
const noValue = (kit: Kit) => formsOf(PASSWORD).filter((form) => JSON.stringify([kit.adapter.sent, kit.adapter.edits, kit.lines]).includes(form));

async function needAndEnd(kit: VaultKit, args = NEED) {
  const result = await kit.service.run(kit.sessionId, args);
  kit.engine.say(kit.sessionId, "학술정보원 로그인이 필요해 요청했습니다.");
  kit.engine.finish(kit.sessionId);
  await settle(kit);
  return result;
}

describe("a hand-over in the chat", () => {
  it("is one message with the one control to give it, sent once", async () => {
    const kit = await vaultKit();
    expect(await needAndEnd(kit)).toMatchObject({ stdout: "fail:handover_sent\n" });
    expect(await kit.service.run(kit.sessionId, NEED)).toMatchObject({ stdout: "fail:handover_waiting\n" });
    await settle(kit);
    const asked = kit.adapter.sent.filter((entry) => entry.out.text.includes("'학술정보원'"));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.out.text).toContain("로그인 정보가 필요합니다");
    expect(asked[0]!.out.text).toContain("lib\u2024example\u2024ac\u2024kr");
    expect(asked[0]!.out.buttons?.flat().map((button) => button.label)).toEqual(["로그인 정보 넣기"]);
    expect(kit.service.state().waiting[0]).toMatchObject({ inChat: true });
  });

  it("is not sent at all when the entry is already there: the AI gets ok", async () => {
    const kit = await vaultKit();
    await kit.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0006", 비밀번호: PASSWORD } });
    const before = kit.adapter.sent.length;
    expect(await kit.service.run(kit.sessionId, NEED)).toMatchObject({ stdout: "ok\n" });
    await settle(kit);
    expect(kit.adapter.sent.length).toBe(before);
  });

  it("given at the PC: the chat is told, and the conversation goes on with one request of the chat, whose answer comes to the chat", async () => {
    const kit = await vaultKit();
    await needAndEnd(kit);
    const [waiting] = kit.service.state().waiting;
    await kit.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0006", 비밀번호: PASSWORD } });
    await settle(kit);
    expect(kit.adapter.texts().some((text) => text.includes("PC에서 '학술정보원'을 넣었습니다"))).toBe(true);
    expect(continued(kit)).toHaveLength(1);
    expect(userItems(kit, kit.sessionId).at(-1)).toMatchObject({ id: `user:cont:${waiting!.id}`, text: continuationText("학술정보원"), origin: { bindingId: kit.binding.id } });
    kit.engine.say(kit.sessionId, "대출 7권을 정리했습니다.");
    kit.engine.finish(kit.sessionId);
    await settle(kit);
    expect(kit.adapter.texts().at(-1)).toContain("대출 7권을 정리했습니다.");
    // Pressing the old control afterwards changes nothing.
    await press(kit, "로그인 정보 넣기");
    expect(continued(kit)).toHaveLength(1);
    expect(noValue(kit)).toEqual([]);
  });

  it("continues nothing in a conversation archived meanwhile, and says so in the chat", async () => {
    const kit = await vaultKit();
    await needAndEnd(kit);
    kit.manager.updateSession(kit.sessionId, { archived: true });
    await kit.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0006", 비밀번호: PASSWORD } });
    await settle(kit);
    expect(continued(kit)).toHaveLength(0);
    expect(kit.adapter.texts().at(-1)).toContain("이 대화는 보관되어 더 보낼 수 없습니다.");
  });

  it("ends after a day and says so", async () => {
    const kit = await vaultKit();
    await needAndEnd(kit);
    kit.clock.now += HANDOFF_TTL + 1;
    await kit.service.tick();
    await settle(kit);
    expect(kit.adapter.texts().at(-1)).toContain("'학술정보원' 넘겨받기 시간이 지났습니다");
  });
});

describe("매번 묻기 in the chat", () => {
  it("asks once before a use with 쓰기 / 안 쓰기; 쓰기 continues the conversation once", async () => {
    const kit = await vaultKit();
    const entry = await kit.service.add({ name: "카드 1", kind: "card", site: "", values: { 카드번호: "4000123412341234" } });
    kit.service.store.setAsk(entry.id, true);
    expect(await needAndEnd(kit, ["need", "--name", "카드 1", "--kind", "card"])).toMatchObject({ stdout: "fail:handover_sent\n" });
    expect(sentWith(kit, "'카드 1'을 쓰려고 합니다").out.buttons?.flat().map((button) => button.label)).toEqual(["쓰기", "안 쓰기"]);
    await press(kit, "쓰기");
    expect(continued(kit)).toHaveLength(1);
    // The other button of the pair is over.
    await press(kit, "안 쓰기");
    expect(kit.adapter.acks.at(-1)!.note).toBe("이미 처리됨");
    expect(await kit.service.run(kit.sessionId, ["need", "--name", "카드 1", "--kind", "card"])).toMatchObject({ stdout: "ok\n" });
  });

  it("안 쓰기 continues nothing", async () => {
    const kit = await vaultKit();
    const entry = await kit.service.add({ name: "카드 1", kind: "card", site: "", values: { 카드번호: "4000123412341234" } });
    kit.service.store.setAsk(entry.id, true);
    await needAndEnd(kit, ["need", "--name", "카드 1", "--kind", "card"]);
    await press(kit, "안 쓰기");
    expect(continued(kit)).toHaveLength(0);
    expect(kit.adapter.shown(kit.adapter.sent.findLast((entry) => entry.out.text.includes("쓰려고"))!.messageId)!.text).toContain("쓰지 않기로 함");
  });
});

describe("fix round 2 (review N3): an entry deleted while 매번 묻기 waits", () => {
  it("ends the hand-over: 쓰기 then continues nothing", async () => {
    const kit = await vaultKit();
    const entry = await kit.service.add({ name: "카드 1", kind: "card", site: "", values: { 카드번호: "4000123412341234" } });
    kit.service.store.setAsk(entry.id, true);
    await needAndEnd(kit, ["need", "--name", "카드 1", "--kind", "card"]);
    kit.service.removeEntry(entry.id);
    expect(kit.service.state().waiting).toEqual([]);
    await press(kit, "쓰기");
    expect(continued(kit)).toHaveLength(0);
  });
});

describe("비밀 보관함 in the chat", () => {
  it("lists names, kinds and sites; renames, turns 매번 묻기 on, deletes and brings back; never a value", async () => {
    const kit = await vaultKit();
    await kit.service.add({ name: "네이버", kind: "login", site: "nid.naver.com", values: { 비밀번호: PASSWORD } });
    await say(kit, "비밀 보관함");
    const list = kit.adapter.last()!;
    expect(list.out.text).toContain("비밀 보관함 · 1개");
    expect(list.out.text).toContain("네이버 · 로그인 · nid\u2024naver\u2024com");
    await press(kit, "네이버");
    expect(kit.adapter.last()!.out.buttons?.flat().map((button) => button.label)).toEqual(["이름 바꾸기", "지우기", "매번 묻기 켜기"]);
    await press(kit, "매번 묻기 켜기");
    expect(kit.service.store.find("네이버")).toMatchObject({ askEachTime: true });
    await press(kit, "이름 바꾸기");
    expect(kit.adapter.last()!.out.text).toContain("새 이름을 보내 주세요");
    await say(kit, "네이버 업무");
    expect(kit.service.store.find("네이버 업무")).not.toBeNull();
    // The new name went to the store, not to the AI.
    expect(kit.engine.sent.some((entry) => entry.text.includes("네이버 업무"))).toBe(false);
    await say(kit, "비밀 보관함");
    await press(kit, "네이버 업무");
    await press(kit, "지우기");
    expect(kit.service.store.summaries()).toEqual([]);
    expect(kit.adapter.last()!.out.text).toContain("지웠습니다");
    await press(kit, "되살리기");
    expect(kit.service.store.find("네이버 업무")).not.toBeNull();
    expect(noValue(kit)).toEqual([]);
  });

  it("says when it is empty, and is just a line for the AI inside a sentence", async () => {
    const kit = await vaultKit();
    await say(kit, "비밀 보관함");
    expect(kit.adapter.last()!.out.text).toContain("비밀 보관함이 비어 있습니다");
    const before = kit.engine.sent.length;
    await say(kit, "비밀 보관함에 뭐가 있는지 알려 줘");
    await until(() => kit.engine.asked > before || kit.engine.steered.length > 0);
  });
});

describe("the channel's log and outgoing text", () => {
  it("hide a stored value under its name, besides the token shapes", async () => {
    const kit = await vaultKit();
    await kit.service.add({ name: "네이버", kind: "login", site: "", values: { 비밀번호: PASSWORD } });
    const lines: string[] = [];
    const log = new ChannelLog(new VaultRedactor(kit.service.scrubber), (line) => lines.push(line));
    log.note("send_failed", new Error(`401 for ${encodeURIComponent(PASSWORD)} with 7000000001:${"A".repeat(35)}`));
    expect(log.scrub(`값 ${PASSWORD}`)).toBe("값 [비밀: 네이버]");
    expect(lines[0]).toContain("[비밀: 네이버]");
    expect(lines[0]).toContain("[봇 토큰]");
    expect(formsOf(PASSWORD).filter((form) => lines[0]!.includes(form))).toEqual([]);
  });
});

describe("fix round 1 in the chat (R5, Minors 5, 6, 10, I5 continuation)", () => {
  it("says the PC's keyring is locked when a stored value cannot be used yet", async () => {
    const kit = await vaultKit();
    await kit.service.add({ name: "노션 키", kind: "api-key", site: "", values: { 키: PASSWORD } });
    vi.spyOn(kit.service.store, "ready", "get").mockReturnValue(false);
    vi.spyOn(kit.service.store, "warm").mockResolvedValue(false);
    expect(await kit.service.run(kit.sessionId, ["need", "--name", "노션 키", "--kind", "api-key"])).toMatchObject({ stdout: "fail:keyring_locked\n" });
    await settle(kit);
    expect(kit.adapter.texts().some((text) => text.startsWith("PC의 보안 저장소가 잠겨 있어"))).toBe(true);
  });

  it("holds a continuation while the chat is paused and sends it, once, when it reopens", async () => {
    const kit = await vaultKit();
    await needAndEnd(kit);
    kit.core.pause(kit.binding.id, true);
    await kit.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0006", 비밀번호: PASSWORD } });
    await settle(kit);
    expect(continued(kit)).toHaveLength(0);
    expect(kit.adapter.texts().some((text) => text.includes("멈춰 두었습니다"))).toBe(false);
    kit.core.pause(kit.binding.id, false);
    await kit.service.tick();
    await kit.service.tick();
    await settle(kit);
    expect(continued(kit)).toHaveLength(1);
    expect(userItems(kit, kit.sessionId).filter((item) => item.id.startsWith("user:cont:"))).toHaveLength(1);
  });

  it("puts one continuation in, however often it is tried (a second try after a restart)", async () => {
    const kit = await vaultKit();
    await needAndEnd(kit);
    const [waiting] = kit.service.state().waiting;
    await kit.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0006", 비밀번호: PASSWORD } });
    await settle(kit);
    kit.service.store.updateHandoff(waiting!.id, { continued: null });
    await kit.service.tick();
    await settle(kit);
    // Counted wherever a continuation can be: written as a request, or waiting in the queue.
    const written = userItems(kit, kit.sessionId).filter((item) => item.text === continuationText("학술정보원")).length;
    const queued = kit.manager.view.sessions.get(kit.sessionId)!.queued.filter((entry) => entry.text === continuationText("학술정보원")).length;
    expect(written + queued).toBe(1);
    expect(continued(kit)).toHaveLength(1);
  });

  it("shows the AI-chosen site as a bare host that is not a link", async () => {
    const kit = await vaultKit();
    await needAndEnd(kit, ["need", "--name", "학술정보원", "--kind", "login", "--site", "https://lib.example.ac.kr/login?x=<b>"]);
    const asked = kit.adapter.texts().find((text) => text.includes("필요합니다"))!;
    expect(asked).toContain("lib․example․ac․kr");
    expect(asked).not.toContain("lib.example.ac.kr");
    expect(asked).not.toContain("<b>");
  });

  it("rename takes only a short single line; a command or a long line ends it, and the line goes its way", async () => {
    const kit = await vaultKit();
    await kit.service.add({ name: "네이버", kind: "login", site: "", values: { 비밀번호: PASSWORD } });
    await say(kit, "비밀 보관함");
    await press(kit, "네이버");
    await press(kit, "이름 바꾸기");
    await say(kit, "상태");
    await say(kit, "다음");
    expect(kit.service.store.find("다음")).toBeNull();
    await say(kit, "비밀 보관함");
    await press(kit, "네이버");
    await press(kit, "이름 바꾸기");
    const before = kit.engine.asked + kit.engine.steered.length;
    await say(kit, "이건 이름이 아니라 아주 긴 부탁입니다. 어제 받은 학생 명단 엑셀에서 3학년만 뽑아서 따로 저장해 줘");
    expect(kit.adapter.texts().some((text) => text === "이름 바꾸기를 그만두었습니다.")).toBe(true);
    await until(() => kit.engine.asked + kit.engine.steered.length > before);
    expect(kit.service.store.find("네이버")).not.toBeNull();
  });
});

describe("merge with unit 14: the everyday words and the vault's open input", () => {
  it("an everyday word typed while an entry's rename waits is that word, never the entry's name, and the rename is over", async () => {
    const kit = await vaultKit();
    await kit.service.add({ name: "네이버", kind: "login", site: "", values: { 비밀번호: PASSWORD } });
    for (const word of ["도움말", "꼬리말 끄기", "/help"]) {
      await say(kit, "비밀 보관함");
      await press(kit, "네이버");
      await press(kit, "이름 바꾸기");
      await say(kit, word);
      expect(kit.service.store.find(word)).toBeNull();
      expect(kit.service.store.find("네이버")).not.toBeNull();
      // The rename is closed: the next short line is not taken as a name either.
      await say(kit, "다음");
      expect(kit.service.store.find("다음")).toBeNull();
    }
    expect(kit.adapter.texts().filter((text) => text.startsWith("그냥 적어 보내면"))).toHaveLength(2);
    expect(kit.adapter.texts()).toContain("끝난 답 아래 꼬리말을 붙이지 않습니다. '꼬리말 켜기'로 다시 켭니다.");
    expect(noValue(kit)).toEqual([]);
  });

  it("the vault's screens and lines are plain: a name with _ or * is shown as typed, with no formatting", async () => {
    const kit = await vaultKit();
    await kit.service.add({ name: "my_key *업무*", kind: "api-key", site: "", values: { 키: PASSWORD } });
    await say(kit, "비밀 보관함");
    expect(kit.adapter.last()!.out.text).toContain("my_key *업무*");
    await press(kit, "my_key *업무*");
    await press(kit, "이름 바꾸기");
    await say(kit, "__새_키__");
    expect(kit.service.store.find("__새_키__")).not.toBeNull();
    expect(kit.adapter.texts().at(-1)).toContain("__새_키__");
    for (const entry of [...kit.adapter.sent, ...kit.adapter.edits]) expect(entry.out.marks ?? []).toEqual([]);
  });

  it("다시 시도 after a continuation does not send it again (it would tell the AI a value is ready)", async () => {
    const kit = await vaultKit();
    await needAndEnd(kit);
    await kit.service.add({ name: "학술정보원", kind: "login", site: "", values: { 아이디: "zz-secret-user-0006", 비밀번호: PASSWORD } });
    await settle(kit);
    kit.engine.say(kit.sessionId, "대출 7권을 정리했습니다.");
    kit.engine.finish(kit.sessionId);
    await settle(kit);
    expect(continued(kit)).toHaveLength(1);
    await say(kit, "다시 시도");
    expect(continued(kit)).toHaveLength(1);
    expect(userItems(kit, kit.sessionId).filter((item) => item.id.startsWith("user:cont:"))).toHaveLength(1);
    expect(kit.adapter.texts().at(-1)).toBe("마지막 요청은 자동으로 이어 간 요청이라 다시 보내지 않습니다. 필요한 말을 새로 적어 보내 주세요.");
  });
});

describe("the chat's secret input (unit 8)", () => {
  it("opens with the brief's notice for the first field, and says when it ran out, with a way to open it again", async () => {
    const kit = await vaultKit({ input: true });
    await needAndEnd(kit);
    const asked = kit.adapter.texts().find((text) => text.includes("필요합니다"))!;
    expect(asked).toContain("다음에 보내는 메시지를 '학술정보원'의 아이디로 받습니다. (1/2)\n이 값은 텔레그램을 거쳐 옵니다. 받는 즉시 지웁니다.\n지금 넣지 않으려면 [나중에]를 누르세요.");
    expect(kit.chat.windows!.current(kit.adapter.dm())).toMatchObject({ fields: ["아이디", "비밀번호"], next: 0 });
    kit.clock.now += 10 * 60_000 + 1;
    await kit.chat.expire();
    await settle(kit);
    // Fix round 4 (P1): the one ending line, naming the input and what happens now, with [다시 넣기].
    expect(kit.adapter.last()!.out.text).toBe("입력 시간(10분)이 지나 '학술정보원' 아이디 입력을 닫았습니다. 지금부터 보내는 글은 AI에게 갑니다. 값은 여기 적지 마세요. 넣으려면 아래 [다시 넣기]를 누르세요.");
    await press(kit, "다시 넣기");
    expect(kit.chat.windows!.current(kit.adapter.dm())).not.toBeNull();
  });
});

describe("the chat's menu (merge with units 5-6)", () => {
  it("has [비밀 보관함], which lists the entries (names only) as the sentence does", async () => {
    const kit = await vaultKit();
    await kit.service.add({ name: "네이버", kind: "login", site: "nid.naver.com", values: { 비밀번호: PASSWORD } });
    await say(kit, "메뉴");
    const menu = kit.adapter.sent.findLast((entry) => entry.out.text.startsWith("메뉴 · 지금:"))!;
    expect(menu.out.buttons!.flat().map((button) => button.label)).toContain("비밀 보관함");
    await press(kit, "비밀 보관함");
    await until(() => kit.adapter.texts().some((text) => text.startsWith("비밀 보관함 · 1개")));
    expect(noValue(kit)).toEqual([]);
  });
});

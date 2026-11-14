// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelsState, CredentialHandoffView, CredentialSummary, CredentialsState } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { PhoneMessenger } from "./PhoneMessenger.tsx";
import { VaultPanel } from "./VaultPanel.tsx";

// The PC's "비밀 보관함" (design §6.5, §11): names, kinds, sites and last use; add with masked
// fields; rename; delete (with 되살리기); 매번 묻기; and the conversations waiting for something
// only the person has. No value is ever shown; typed values are not kept by the page. Stand-in
// answers only; the values are made up.

const VALUE = "zz-secret-pass-0007";
const entry = (extra: Partial<CredentialSummary> = {}): CredentialSummary => ({ id: "c1", name: "네이버", kind: "login", site: "nid.naver.com", fields: ["아이디", "비밀번호"], secret: { 아이디: false, 비밀번호: true }, createdAt: Date.UTC(2026, 10, 12, 1), lastUsedAt: null, usedIn: [], askEachTime: false, held: "sealed", ...extra });
const waiting = (extra: Partial<CredentialHandoffView> = {}): CredentialHandoffView => ({ id: "h1", sessionId: "s1", sessionLabel: "「도서관」 › 「휴대폰 · 11/12」", name: "학술정보원", kind: "login", site: "lib.example.ac.kr", fields: ["아이디", "비밀번호"], secret: { 아이디: false, 비밀번호: true }, mode: "give", createdAt: 1, expiresAt: Date.UTC(2026, 10, 13, 1), inChat: true, ...extra });

function fixture(initial: CredentialsState) {
  let state = initial;
  const calls: { method: string; path: string; body: unknown }[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (path.startsWith("/api/channels/credentials")) return state;
    if (method === "GET" && path === "/api/channels") return { bots: [] } satisfies ChannelsState;
    if (path === "/api/host/autostart") return { label: "", enabled: false, supported: false };
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = { request, isRemote: false } as unknown as Api;
  return { api, calls, set: (next: CredentialsState) => { state = next; }, sent: (method: string) => calls.filter((call) => call.method === method) };
}
const click = async (name: string | RegExp, scope: HTMLElement = document.body) => { await act(async () => { fireEvent.click(within(scope).getByRole("button", { name })); }); };
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("비밀 보관함 at the PC", () => {
  it("lists name, kind, site and last use, and never a value", async () => {
    const f = fixture({ entries: [entry(), entry({ id: "c2", name: "카드 1", kind: "card", site: "", fields: ["카드번호"], lastUsedAt: Date.UTC(2026, 10, 12, 5), askEachTime: true, held: "memory" })], waiting: [], trash: [] });
    await act(async () => { render(<VaultPanel api={f.api} />); });
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]!).getByText("네이버")).toBeTruthy();
    expect(rows[0]!.textContent).toContain("로그인");
    expect(rows[0]!.textContent).toContain("nid.naver.com");
    expect(rows[0]!.textContent).toContain("쓰지 않음");
    expect(rows[1]!.textContent).toContain("카드");
    expect(rows[1]!.textContent).toContain("마지막 사용");
    expect(rows[1]!.textContent).toContain("이번 한 번만");
    expect((within(rows[1]!).getByRole("checkbox", { name: "매번 묻기" }) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelectorAll("input[type=password]").length).toBe(0);
  });

  it("adds with masked fields per kind, sends the values once, and keeps none of them on the page", async () => {
    const f = fixture({ entries: [], waiting: [], trash: [] });
    await act(async () => { render(<VaultPanel api={f.api} />); });
    await click("항목 추가");
    type("이름", "학교 포털");
    type("사이트", "portal.example.ac.kr");
    const id = screen.getByLabelText("아이디") as HTMLInputElement, pw = screen.getByLabelText("비밀번호") as HTMLInputElement;
    // 아이디 is not a secret: shown as typed. 비밀번호 is masked, not remembered by the browser, not spell-checked.
    expect(id.type).toBe("text");
    expect(pw.type).toBe("password");
    expect(pw.getAttribute("autocomplete")).toBe("new-password");
    expect(pw.getAttribute("spellcheck")).toBe("false");
    fireEvent.change(id, { target: { value: "zz-secret-user-0007" } });
    fireEvent.change(pw, { target: { value: VALUE } });
    f.set({ entries: [entry({ name: "학교 포털" })], waiting: [], trash: [] });
    await click("넣기");
    expect(f.sent("POST")).toEqual([{ method: "POST", path: "/api/channels/credentials", body: { name: "학교 포털", kind: "login", site: "portal.example.ac.kr", values: { 아이디: "zz-secret-user-0007", 비밀번호: VALUE }, secret: { 아이디: false, 비밀번호: true } } }]);
    expect(document.body.innerHTML).not.toContain(VALUE);
    expect(screen.queryByLabelText("비밀번호")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("봉인해 두었습니다");
  });

  it("fills a conversation's waiting hand-over by its name and fields, and says the conversation goes on", async () => {
    const f = fixture({ entries: [], waiting: [waiting()], trash: [] });
    await act(async () => { render(<VaultPanel api={f.api} />); });
    const card = screen.getByRole("group", { name: "기다리는 요청" });
    expect(card.textContent).toContain("「도서관」 › 「휴대폰 · 11/12」");
    expect(card.textContent).toContain("'학술정보원' 로그인 정보");
    expect(card.textContent).toContain("휴대폰에서도 물었습니다");
    await click("넣기", card);
    expect((screen.getByLabelText("이름") as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: "zz-secret-user-0007" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: VALUE } });
    f.set({ entries: [entry({ name: "학술정보원" })], waiting: [], trash: [] });
    await click(/^넣기$/, screen.getByRole("form", { name: "비밀 넣기" }));
    expect((f.sent("POST")[0]!.body as { name: string }).name).toBe("학술정보원");
    expect(screen.getByRole("status").textContent).toContain("기다리던 대화가 이어집니다");
  });

  it("answers 매번 묻기 for a conversation with 쓰기 or 안 쓰기", async () => {
    const f = fixture({ entries: [entry({ askEachTime: true })], waiting: [waiting({ id: "h2", mode: "use", name: "네이버", kind: "login" })], trash: [] });
    await act(async () => { render(<VaultPanel api={f.api} />); });
    const card = screen.getByRole("group", { name: "기다리는 요청" });
    expect(card.textContent).toContain("'네이버'를 쓰려고 합니다");
    await click("쓰기", card);
    expect(f.sent("POST")).toEqual([{ method: "POST", path: "/api/channels/credentials/handoffs/h2", body: { use: true } }]);
  });

  it("renames, turns 매번 묻기 on, deletes and brings back", async () => {
    const f = fixture({ entries: [entry()], waiting: [], trash: [] });
    await act(async () => { render(<VaultPanel api={f.api} />); });
    const row = screen.getByRole("listitem");
    await act(async () => { fireEvent.click(within(row).getByRole("checkbox", { name: "매번 묻기" })); });
    expect(f.sent("PATCH")).toEqual([{ method: "PATCH", path: "/api/channels/credentials/c1", body: { askEachTime: true } }]);
    await click("이름 바꾸기", row);
    fireEvent.change(screen.getByLabelText("새 이름"), { target: { value: "네이버 업무" } });
    await click("저장");
    expect(f.sent("PATCH")[1]!.body).toEqual({ name: "네이버 업무" });
    f.set({ entries: [], waiting: [], trash: [{ id: "c1", name: "네이버", removedAt: Date.now() }] });
    await click("지우기", screen.getByRole("listitem"));
    expect(f.sent("DELETE")).toEqual([{ method: "DELETE", path: "/api/channels/credentials/c1", body: undefined }]);
    expect(screen.getByRole("status").textContent).toContain("「네이버」를 지웠습니다");
    await click("되살리기");
    expect(f.sent("POST")).toEqual([{ method: "POST", path: "/api/channels/credentials/c1/restore", body: undefined }]);
  });

  it("shows the other hosts the person allowed a login on, and removes one", async () => {
    const f = fixture({ entries: [entry({ hosts: ["m.naver.com", "sso.example.org"] })], waiting: [], trash: [] });
    await act(async () => { render(<VaultPanel api={f.api} />); });
    const row = screen.getByRole("listitem");
    expect(row.textContent).toContain("다른 주소: m.naver.com 빼기, sso.example.org 빼기");
    await click("m.naver.com 빼기", row);
    expect(f.sent("PATCH")).toEqual([{ method: "PATCH", path: "/api/channels/credentials/c1", body: { hosts: ["sso.example.org"] } }]);
  });

  it("shows a secret field while typing only when 보기 is pressed, and keeps what was typed when saving fails", async () => {
    const f = fixture({ entries: [], waiting: [], trash: [] });
    f.api.request = vi.fn(async (method: string, path: string) => {
      if (method === "POST") throw new Error("저장하지 못했습니다.");
      if (path.startsWith("/api/channels/credentials")) return { entries: [], waiting: [], trash: [] };
      throw new Error("unexpected");
    }) as never;
    await act(async () => { render(<VaultPanel api={f.api} />); });
    await click("항목 추가");
    const pw = screen.getByLabelText("비밀번호") as HTMLInputElement;
    const show = screen.getByRole("button", { name: "비밀번호 보기" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { fireEvent.click(show); });
    expect(pw.type).toBe("text");
    await act(async () => { fireEvent.click(show); });
    expect(pw.type).toBe("password");
    type("이름", "학교 포털");
    fireEvent.change(screen.getByLabelText("아이디"), { target: { value: "zz-user" } });
    fireEvent.change(pw, { target: { value: VALUE } });
    await click(/^넣기$/, screen.getByRole("form", { name: "비밀 넣기" }));
    expect(screen.getByRole("alert").textContent).toContain("저장하지 못했습니다");
    expect((screen.getByLabelText("비밀번호") as HTMLInputElement).value).toBe(VALUE);
  });

  it("says the PC's keyring is locked, tries once when opened, and again on 다시 시도", async () => {
    const f = fixture({ entries: [entry()], waiting: [], trash: [], locked: true });
    await act(async () => { render(<VaultPanel api={f.api} />); });
    expect(screen.getByRole("alert").textContent).toContain("PC의 키링이 잠겨 있습니다");
    expect(f.sent("POST").filter((call) => call.path === "/api/channels/credentials/unlock")).toHaveLength(1);
    await click("다시 시도");
    expect(f.sent("POST").filter((call) => call.path === "/api/channels/credentials/unlock")).toHaveLength(2);
  });

  it("is a tab of the 휴대폰 메신저 dialog, and reachable before any bot is registered", async () => {
    const f = fixture({ entries: [entry()], waiting: [], trash: [] });
    await act(async () => { render(<PhoneMessenger api={f.api} openExternal={vi.fn(async () => {})} copy={vi.fn(async () => {})} readClipboard={vi.fn(async () => "")} onClose={vi.fn()} />); });
    await click("비밀 보관함");
    expect(screen.getByRole("listitem").textContent).toContain("네이버");
  });
});

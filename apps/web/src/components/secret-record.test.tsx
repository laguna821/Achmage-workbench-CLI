// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelAuditRow, ChannelBot, ChannelsState } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { PhoneMessenger } from "./PhoneMessenger.tsx";

// The 기록 tab names what the secret input did (unit 8) by the entry's name, never a value.
const bot: ChannelBot = { kind: "telegram", id: "7000000001", username: "wb_7k3q9x_bot", name: "내 Workbench", createdAt: 1, token: "sealed", status: { state: "connected", detail: null }, pairing: { expiresAt: null, request: null, lockedUntil: null }, bindings: [] };
const row = (id: number, action: string, target: string | null, result: string | null): ChannelAuditRow => ({ id, at: Date.UTC(2026, 10, 12, 3, id), bindingId: null, kind: "telegram", action, sessionId: null, requestId: null, target, result });

beforeEach(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the record of the secret input", () => {
  it("says what happened, by the entry's name", async () => {
    const rows = [row(4, "secret.received", "학술정보원", "sealed"), row(3, "secret.refused", "학술정보원", "not_text"), row(2, "secret.asked", "학술정보원", "send-and-delete"), row(1, "secret.cancelled", null, null)];
    const request = vi.fn(async (method: string, path: string) => {
      if (path === "/api/channels") return { bots: [bot] } satisfies ChannelsState;
      if (path.startsWith("/api/channels/audit")) return { rows, names: {} };
      if (path === "/api/host/autostart") return { label: "", enabled: false, supported: false };
      throw new Error(`unexpected ${method} ${path}`);
    });
    await act(async () => { render(<PhoneMessenger api={{ request, isRemote: false } as unknown as Api} openExternal={vi.fn(async () => {})} copy={vi.fn(async () => {})} readClipboard={vi.fn(async () => "")} onClose={vi.fn()} />); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "기록" })); });
    const text = document.querySelector(".pm-record")!.textContent!;
    expect(text).toContain("비밀 받음 · 학술정보원 · 봉인");
    expect(text).toContain("비밀 입력 거절 · 글이 아님");
    expect(text).toContain("비밀 입력 열림 · 학술정보원");
    expect(text).toContain("비밀 입력 취소");
  });

  it("says what a stored login did (unit 9), by name and site, and a file held back for a value in it", async () => {
    const rows = [row(5, "credential.used", "도서관 · lib.example.ac.kr", "ok"), row(4, "credential.used", "도서관 · evil.example", "wrong_site"), row(3, "login.step", "도서관", "approved"), row(2, "login.step", "도서관", "code:ok"), row(1, "file.blocked", null, "secret-content"), row(0, "file.blocked", null, "secret-content:2"), row(-1, "file.blocked", null, "unreadable:1")];
    const request = vi.fn(async (method: string, path: string) => {
      if (path === "/api/channels") return { bots: [bot] } satisfies ChannelsState;
      if (path.startsWith("/api/channels/audit")) return { rows, names: {} };
      if (path === "/api/host/autostart") return { label: "", enabled: false, supported: false };
      throw new Error(`unexpected ${method} ${path}`);
    });
    await act(async () => { render(<PhoneMessenger api={{ request, isRemote: false } as unknown as Api} openExternal={vi.fn(async () => {})} copy={vi.fn(async () => {})} readClipboard={vi.fn(async () => "")} onClose={vi.fn()} />); });
    await act(async () => { fireEvent.click(screen.getByRole("tab", { name: "기록" })); });
    const text = document.querySelector(".pm-record")!.textContent!;
    expect(text).toContain("저장한 로그인 넣음 · 도서관 · lib.example.ac.kr");
    expect(text).toContain("다른 사이트라 로그인 넣지 않음 · 도서관 · evil.example");
    expect(text).toContain("로그인 단계 · 도서관 · 다른 앱에서 승인");
    expect(text).toContain("로그인 단계 · 도서관 · 인증번호 넣음");
    expect(text).toContain("비밀 값이 든 파일을 보내지 않음");
    // Round 2: one row per reason, with its count.
    expect(text).toContain("비밀 값이 든 파일 2개를 보내지 않음");
    expect(text).toContain("읽지 못한 파일 1개를 보내지 않음");
  });
});

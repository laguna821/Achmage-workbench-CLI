// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { Schedule, Session } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { ScheduleDialog } from "./ScheduleDialog.tsx";

// A schedule made from a paired phone chat is named as such at the PC, and says why it is off.

afterEach(cleanup);

const session = { id: "s1", purpose: "휴대폰 · 11/13" } as Session;
const schedule = (extra: Partial<Schedule>): Schedule => ({ id: "x", sessionId: "s1", text: "아침 요약", when: { kind: "daily", time: "09:00" }, enabled: true, nextAt: Date.now() + 3_600_000, lastAt: null, createdAt: 0, ...extra });

describe("the PC's schedule screen", () => {
  it("names a schedule made from a phone chat, and says it is off because that chat was locked", () => {
    render(<ScheduleDialog api={{} as Api} session={session} onClose={vi.fn()} onError={vi.fn()} schedules={[
      schedule({ id: "a", origin: { channel: "telegram", bindingId: "b1" }, enabled: false, offReason: "locked" }),
      schedule({ id: "b", text: "PC 예약" }),
    ]} />);
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows.find((row) => row.includes("아침 요약"))).toContain("휴대폰 채팅에서 만든 예약");
    expect(rows.find((row) => row.includes("아침 요약"))).toContain("휴대폰 채팅을 잠가 꺼짐 · 잠금을 풀어야 켤 수 있습니다");
    expect(rows.find((row) => row.includes("PC 예약"))).not.toContain("휴대폰");
  });
});

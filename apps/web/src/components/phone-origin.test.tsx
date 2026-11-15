// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, TranscriptItem } from "@workbench/contracts";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { Transcript } from "./Transcript.tsx";
import { QueuedList } from "./WorkView.tsx";
import { initialState } from "../state.ts";

// What came from the paired phone is marked "휴대폰" at the PC: the request in the conversation and
// a request that waits for its turn. Nothing else is marked.

afterEach(cleanup);

const origin = { channel: "telegram" as const, bindingId: "b1", context: 1 };

describe("the 휴대폰 mark", () => {
  it("is on a request sent from the phone, and not on one typed at the PC", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "u1", text: "3학년만 뽑아서 따로 저장해 줘", at: 1, origin },
      { kind: "assistant", id: "a1", text: "저장했습니다.", streaming: false, at: 2 },
      { kind: "user", id: "u2", text: "PC에서 쓴 요청", at: 3 },
    ];
    const view = render(<DocContext.Provider value={{ state: initialState, actions: {} as DocActions }}><section className="pane"><Transcript sessionId="s" items={items} provider="claude" running={false} loading={false} onAnswer={() => {}} /></section></DocContext.Provider>);
    const requests = [...view.container.querySelectorAll<HTMLElement>(".turn-request")];
    const phone = requests.find((element) => element.textContent?.includes("3학년만"))!;
    const desk = requests.find((element) => element.textContent?.includes("PC에서 쓴 요청"))!;
    expect(within(phone).getByText("휴대폰").getAttribute("title")).toBe("휴대폰 메신저에서 보낸 요청");
    expect(within(desk).queryByText("휴대폰")).toBeNull();
  });

  it("is on a waiting request from the phone, also when it is held back", () => {
    const session = { id: "s", archivedAt: null, queued: [
      { id: "q1", text: "그다음 일정도 정리해 줘", refs: [], create: null, at: 1, held: true, origin },
      { id: "q2", text: "PC에서 기다리는 요청", refs: [], create: null, at: 2 },
    ] } as unknown as Session;
    render(<QueuedList session={session} busy={false} actions={{ send: vi.fn(), cancel: vi.fn(), edit: vi.fn() } as never} />);
    const [phone, desk] = screen.getAllByRole("listitem");
    expect(within(phone!).getByText("휴대폰").getAttribute("title")).toBe("휴대폰 메신저에서 보낸 요청");
    expect(within(desk!).queryByText("휴대폰")).toBeNull();
  });
});

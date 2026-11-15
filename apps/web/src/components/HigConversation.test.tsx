// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Attachment } from "@workbench/contracts";
import { Composer } from "./Composer.tsx";
import { MessageImage } from "./Attachments.tsx";

const media = vi.hoisted(() => ({ release: vi.fn(), retain: vi.fn(), decode: vi.fn() }));
vi.mock("../api.ts", async importOriginal => ({ ...await importOriginal<typeof import("../api.ts")>(), attachmentHostId: () => "host", retainAttachmentUrl: media.retain }));
vi.mock("../../../../vendor/paseo/image-decoding/image-decoding.ts", () => ({ decodeMarkdownImage: media.decode }));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  media.release.mockReset(); media.retain.mockReset(); media.decode.mockReset();
  media.retain.mockImplementation(() => ({ promise: Promise.resolve("blob:captured-image"), release: media.release }));
  media.decode.mockResolvedValue({ width: 800, height: 600 });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps core controls available and closes optional tools with Escape without changing send/queue behavior", async () => {
  const send = vi.fn().mockResolvedValue(true), stop = vi.fn();
  const view = render(<Composer draftKey="hig-test" placeholder="요청 쓰기" busy waiting steerable onSend={send} onStop={stop} left={<button>권한</button>} target={<><button>모델</button><button>추론 강도</button></>} tools={<button>계획 먼저</button>} />);
  const disclosure = view.container.querySelector<HTMLDetailsElement>(".composer-tools")!;
  disclosure.open = true;
  fireEvent.keyDown(screen.getByRole("button", { name: "계획 먼저" }), { key: "Escape" });
  expect(disclosure.open).toBe(false);
  expect(document.activeElement).toBe(disclosure.querySelector("summary"));
  expect(screen.getByRole("button", { name: "권한" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "모델" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "추론 강도" })).toBeTruthy();
  const input = screen.getByRole("textbox", { name: "요청 입력" });
  fireEvent.change(input, { target: { value: "다음 요청" } });
  fireEvent.click(screen.getByRole("button", { name: "끝나면 보내기" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("다음 요청", "queue"));
  fireEvent.click(screen.getByRole("button", { name: "중단" }));
  expect(stop).toHaveBeenCalledTimes(1);
});

it("the quiet row: 첨부, 도구, the engine and send in view; every other control one disclosure away, unchanged", async () => {
  const send = vi.fn().mockResolvedValue(true);
  const view = render(<Composer draftKey="quiet-test" placeholder="요청 쓰기" busy={false} onSend={send} onFiles={vi.fn()}
    engine={<button className="select-button">Codex</button>} toolsOn={["계획 먼저"]}
    left={<><button>자동</button><button>13%</button></>} target={<><button>Fake</button><button>기본</button></>} tools={<><button>계획 먼저</button><button aria-label="프로젝트 문서 붙이기">문서 붙이기</button></>} />);
  const bar = view.container.querySelector<HTMLElement>(".composer-bar")!;
  const row = [...bar.querySelectorAll(".composer-left > *, .composer-right > *")];
  expect(row.map((element) => element.className.split(" ")[0])).toEqual(["composer-file-picker", "composer-tools", "select-button", "icon-button"]);
  const disclosure = view.container.querySelector<HTMLDetailsElement>(".composer-tools")!;
  expect(disclosure.open).toBe(false);
  // What is on stays named on the closed key.
  expect(disclosure.querySelector("summary")!.textContent).toContain("계획 먼저");
  for (const name of ["자동", "13%", "Fake", "기본", "계획 먼저", "프로젝트 문서 붙이기"]) expect(disclosure.contains(screen.getAllByRole("button", { name, hidden: true }).at(-1)!)).toBe(true);
  disclosure.open = true;
  fireEvent.keyDown(screen.getByRole("button", { name: "Fake" }), { key: "Escape" });
  expect(disclosure.open).toBe(false);
  expect(screen.getByRole("button", { name: "사진 또는 파일 첨부" })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "요청 입력" }), { target: { value: "요청" } });
  fireEvent.click(screen.getByRole("button", { name: "보내기" }));
  await waitFor(() => expect(send).toHaveBeenCalledWith("요청", "auto"));
});

const attachment = { id: "picture", name: "결과.png", mime: "image/png", size: 1024 } as Attachment;
it("opens a captured inline image even without a supplied gallery and restores keyboard focus", async () => {
  render(<MessageImage attachment={attachment} gallery={[]} />);
  const trigger = screen.getByRole("button", { name: "결과.png 크게 보기" });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  trigger.focus(); fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "결과.png" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "그림 닫기" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(media.release).toHaveBeenCalled();
});

it("makes failed inline image loading visible and allows a retry", async () => {
  media.retain.mockImplementationOnce(() => ({ promise: Promise.reject(new Error("연결을 확인해 주세요")), release: media.release }));
  render(<MessageImage attachment={attachment} gallery={[attachment]} />);
  await screen.findByText("연결을 확인해 주세요");
  fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "결과.png 크게 보기" }).hasAttribute("disabled")).toBe(false));
  expect(media.retain).toHaveBeenCalledTimes(2);
});

it("marks the input with the engine it sends to, even when the pane around it shows another engine", () => {
  // A Claude chat's document whose document AI was switched to Codex: the line follows the send target.
  const view = render(<section className="pane" data-theme="light"><Composer draftKey="doc-ai" placeholder="이 문서에 요청하기" busy={false} provider="codex" onSend={vi.fn()} /></section>);
  const composer = () => view.container.querySelector<HTMLElement>(".hig-composer")!;
  expect(composer().dataset.provider).toBe("codex");
  view.rerender(<section className="pane" data-theme="light"><Composer draftKey="doc-ai" placeholder="이 문서에 요청하기" busy={false} provider="claude" onSend={vi.fn()} /></section>);
  expect(composer().dataset.provider).toBe("claude");
  view.rerender(<section className="pane" data-theme="light"><Composer draftKey="doc-ai" placeholder="이 문서에 요청하기" busy={false} onSend={vi.fn()} /></section>);
  expect(composer().hasAttribute("data-provider")).toBe(false);
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@workbench/contracts";
import { Composer } from "./Composer.tsx";
import { toBlocks } from "./Transcript.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("Composer", () => {
  it("sends on Enter but not while a Korean syllable is being composed", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer draftKey="t" placeholder="입력" busy={false} onSend={onSend} />);
    const input = screen.getByPlaceholderText("입력");
    fireEvent.change(input, { target: { value: "안녕" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith("안녕", "auto"));
  });

  it("keeps taking requests while the engine works: Enter steers, Alt+Enter waits for the end", async () => {
    const onSend = vi.fn(async () => true);
    const { rerender } = render(<Composer draftKey="busy" placeholder="입력" busy steerable onSend={onSend} onStop={() => undefined} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "방향 바꿔" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(onSend).toHaveBeenLastCalledWith("방향 바꿔", "auto"));
    fireEvent.change(input, { target: { value: "다음에 이것도" } });
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    await vi.waitFor(() => expect(onSend).toHaveBeenLastCalledWith("다음에 이것도", "queue"));
    // An engine that cannot take a request mid-turn keeps it for the end.
    rerender(<Composer draftKey="busy" placeholder="입력" busy steerable={false} onSend={onSend} onStop={() => undefined} />);
    fireEvent.change(input, { target: { value: "끝나면" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(onSend).toHaveBeenLastCalledWith("끝나면", "queue"));
    expect(screen.getByRole("button", { name: "중단" })).toBeTruthy();
  });

  it("keeps the draft per key", () => {
    const { unmount } = render(<Composer draftKey="w1" placeholder="입력" busy={false} onSend={async () => true} />);
    fireEvent.change(screen.getByPlaceholderText("입력"), { target: { value: "초안" } });
    unmount();
    render(<Composer draftKey="w1" placeholder="입력" busy={false} onSend={async () => true} />);
    expect((screen.getByPlaceholderText("입력") as HTMLTextAreaElement).value).toBe("초안");
  });
});

describe("toBlocks", () => {
  it("folds consecutive tool calls and shows the engine label once per turn", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "u", text: "q", at: 1 },
      { kind: "assistant", id: "a1", text: "먼저 볼게요", streaming: false, at: 2 },
      { kind: "tool", id: "t1", tool: "command", title: "ls", detail: null, output: null, status: "completed", at: 3 },
      { kind: "tool", id: "t2", tool: "search", title: "읽기", detail: null, output: null, status: "completed", at: 4 },
      { kind: "reasoning", id: "r", text: "", at: 5 },
      { kind: "assistant", id: "a2", text: "끝", streaming: false, at: 6 },
    ];
    const blocks = toBlocks(items);
    expect(blocks.map((block) => block.type)).toEqual(["user", "assistant", "work", "assistant"]);
    expect(blocks.filter((block) => "speaker" in block && block.speaker)).toHaveLength(1);
  });
});

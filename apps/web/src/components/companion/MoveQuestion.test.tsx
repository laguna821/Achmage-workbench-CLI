// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveQuestion } from "./MoveQuestion.tsx";

afterEach(cleanup);

// The question before a document tab is moved beside a conversation (대화 옆에) while its editor
// reports unsaved edits. The person decides; the app's own comparison is only said.
describe("the move question", () => {
  const ask = (said: { certain: boolean; same: boolean }) => {
    const go = vi.fn(async () => undefined), drop = vi.fn(async () => undefined), close = vi.fn();
    render(<MoveQuestion name="강의안.md" {...said} onSave={go} onDrop={drop} onClose={close} />);
    return { go, drop, close };
  };

  it("offers three choices — 취소 (focused), 저장하지 않고 옮기기, 저장하고 옮기기 — and says what dropping does", async () => {
    const at = ask({ certain: true, same: false });
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(["취소", "저장하지 않고 옮기기", "저장하고 옮기기"]);
    expect(document.activeElement?.textContent).toBe("취소");
    expect(screen.getByRole("dialog").textContent).toMatch(/편집기에서 저장하지 않은 내용은 버리고, 파일은 그대로 둡니다/);
    fireEvent.click(screen.getByRole("button", { name: "저장하지 않고 옮기기" }));
    await waitFor(() => expect(at.drop).toHaveBeenCalledTimes(1));
    expect(at.go).not.toHaveBeenCalled();
    await waitFor(() => expect(at.close).toHaveBeenCalled());
  });

  it("저장하고 옮기기 saves first; 취소 runs nothing", async () => {
    const at = ask({ certain: true, same: false });
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(at.go).not.toHaveBeenCalled(); expect(at.drop).not.toHaveBeenCalled();
    cleanup();
    const again = ask({ certain: true, same: false });
    fireEvent.click(screen.getByRole("button", { name: "저장하고 옮기기" }));
    await waitFor(() => expect(again.go).toHaveBeenCalledTimes(1));
  });

  it("when the editor's text equals the saved revision, it says so and does not assert unsaved edits — the three choices stay", () => {
    ask({ certain: true, same: true });
    const text = screen.getByRole("dialog").textContent ?? "";
    expect(text).toContain("저장된 판과 같아 보입니다");
    expect(text).toContain("편집기가 바뀐 내용이 있다고 알립니다");
    expect(text).not.toContain("저장하지 않은 편집이 있습니다");
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });
});

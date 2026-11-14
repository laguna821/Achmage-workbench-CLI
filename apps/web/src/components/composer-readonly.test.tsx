// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer.tsx";

beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} })); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

// A document AI whose document is gone is history: its composer (disabled by the conversation
// view) sends nothing by any route — Enter, the queue key, a slash command, the send button.
describe("a read-only conversation's composer", () => {
  it("sends nothing by keyboard, queue, slash command or button", async () => {
    const onSend = vi.fn(async () => true);
    render(<Composer draftKey="retired" placeholder="입력" busy={false} disabled onSend={onSend} />);
    const input = screen.getByPlaceholderText("입력");
    for (const text of ["안녕", "/compact"]) {
      fireEvent.change(input, { target: { value: text } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key: "Enter", altKey: true });
    }
    for (const button of screen.queryAllByRole("button", { name: /보내기/ })) fireEvent.click(button);
    await new Promise((done) => setTimeout(done, 20));
    expect(onSend).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Rail } from "./Rail.tsx";
import { useWorkModeKeys } from "../../workmodes.ts";

// Technical review K1 (the coordinator's final ruling): while the focused view has work modes (a document
// with its conversation: 대화만 … 읽기, Alt+1–5, advertised in the document's ⋯ menu), Alt+1–5 are the work
// modes' and the rail ignores them; everywhere else Alt+1–6 go to the rail. The rail's tooltips show a
// key only while it is the rail's. Composed as App.tsx composes them (useWorkModeKeys(workMode !== null)
// + <Rail modeKeys={workMode !== null}>).
afterEach(cleanup);

function Frame({ modes, onMode, onPlace }: { modes: boolean; onMode: (mode: string) => void; onPlace: (place: string) => void }) {
  useWorkModeKeys(modes, onMode);
  return <Rail lit="now" attention={0} running={0} compact={false} searchHint="찾기 (Ctrl+K)" onPlace={onPlace} onRunning={() => {}} settings={null} modeKeys={modes} />;
}
const press = (digit: number) => fireEvent.keyDown(window, { key: String(digit), code: `Digit${digit}`, altKey: true });

it("a document focused: Alt+1 and Alt+5 switch its work modes only; Alt+6 still goes to 볼트", () => {
  const onMode = vi.fn(), onPlace = vi.fn();
  render(<Frame modes onMode={onMode} onPlace={onPlace} />);
  press(1); press(5); press(6);
  expect(onMode.mock.calls.map(([mode]) => mode)).toEqual(["chat", "read"]);
  expect(onPlace.mock.calls.map(([place]) => place)).toEqual(["vault"]);
  expect(screen.getByRole("button", { name: "지금" }).getAttribute("title")).not.toMatch(/Alt\+1/);
  expect(screen.getByRole("button", { name: "볼트" }).getAttribute("title")).toMatch(/Alt\+6/);
});

it("a conversation without work modes focused: Alt+1 and Alt+5 go to the rail, and its tooltips say so", () => {
  const onMode = vi.fn(), onPlace = vi.fn();
  render(<Frame modes={false} onMode={onMode} onPlace={onPlace} />);
  press(1); press(5);
  expect(onMode).not.toHaveBeenCalled();
  expect(onPlace.mock.calls.map(([place]) => place)).toEqual(["now", "search"]);
  expect(screen.getByRole("button", { name: "지금" }).getAttribute("title")).toMatch(/Alt\+1/);
});

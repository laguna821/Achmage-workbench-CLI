// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EngineMark } from "./EngineMark.tsx";

afterEach(cleanup);

it("names its engine so the mark takes that engine's color", () => {
  const { container } = render(<><EngineMark provider="claude" /><EngineMark provider="codex" className="extra" /></>);
  const marks = [...container.querySelectorAll("svg.engine-mark")];
  expect(marks.map((mark) => mark.getAttribute("data-provider"))).toEqual(["claude", "codex"]);
  expect(marks[1]!.classList.contains("extra")).toBe(true);
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { REMOTE_RAIL_OMIT } from "../../remote-links.ts";
import { Rail } from "./Rail.tsx";

// 0.5.6 round 2: the vault (볼트, 자료) stays the PC's — a phone's rail has no 볼트 key.
afterEach(cleanup);
const rail = (omit?: readonly ("vault")[]) => render(<Rail lit="projects" attention={0} running={0} compact={false} searchHint="찾기" onPlace={() => undefined} onRunning={() => undefined} settings={null} omit={omit} />);

it("on a phone: no 볼트; the other places stay", () => {
  rail(REMOTE_RAIL_OMIT);
  expect(screen.queryByRole("button", { name: "볼트" })).toBeNull();
  for (const name of ["지금", "프로젝트", "문서", "활동", "찾기"]) expect(screen.getByRole("button", { name })).toBeTruthy();
});

it("on the PC: 볼트 as before", () => {
  rail();
  expect(screen.getByRole("button", { name: "볼트" })).toBeTruthy();
});

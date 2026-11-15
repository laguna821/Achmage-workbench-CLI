// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderStatus } from "@workbench/contracts";
import { EngineMissing, EngineTabs, noEngineReady } from "./StartView.tsx";

// 지금 with no engine connected (design review I6): one line above the request row says so, with a
// key to 설정 › AI 엔진; the engine keys do not look ready.
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const status = (patch: Partial<ProviderStatus>) => ({ installed: false, loggedIn: false, billingVars: [], usage: [], ...patch }) as unknown as ProviderStatus;

it("knows when no engine is ready, and says nothing before the engines have been looked for", () => {
  expect(noEngineReady({})).toBe(false);
  expect(noEngineReady({ claude: status({}), codex: status({ installed: true }) })).toBe(true);
  expect(noEngineReady({ claude: status({ installed: true, loggedIn: true }) })).toBe(false);
});

it("says it in one line with a key to 설정 › AI 엔진", () => {
  const onConnect = vi.fn();
  render(<EngineMissing onConnect={onConnect} />);
  expect(screen.getByRole("status").textContent).toContain("AI 엔진이 아직 연결되지 않았습니다.");
  fireEvent.click(screen.getByRole("button", { name: "AI 엔진 연결" }));
  expect(onConnect).toHaveBeenCalledTimes(1);
});

it("an engine that is not ready carries no engine mark on its key", () => {
  const { container } = render(<EngineTabs value="claude" onChange={() => {}} ready={() => false} />);
  expect(container.querySelector(".engine-tabs svg, .engine-tabs .engine-mark")).toBeNull();
  cleanup();
  const ready = render(<EngineTabs value="claude" onChange={() => {}} ready={() => true} />);
  expect(ready.container.querySelector(".engine-tabs [role=radio][aria-checked=true]")!.innerHTML).not.toBe("Claude");
});

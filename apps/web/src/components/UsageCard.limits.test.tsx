// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { UsageCard, UsageLine } from "./UsageCard.tsx";
import { readUsagePlace } from "../theme.ts";

// atlas-look (the owner: bars, every limit, Fable too; where it shows is a choice).
afterEach(cleanup);
const soon = Date.now() + 3 * 3_600_000;
const providers = {
  claude: { provider: "claude", installed: true, loggedIn: true, billingVars: [], usage: [
    { label: "5시간", usedPercent: 12, resetsAt: soon }, { label: "주간", usedPercent: 78, resetsAt: soon }, { label: "주간 Fable", usedPercent: 93, resetsAt: soon },
  ] },
  codex: { provider: "codex", installed: true, loggedIn: true, billingVars: [], usage: [
    { label: "5시간", usedPercent: 12, resetsAt: soon }, { label: "주간 · Opus", usedPercent: 78, resetsAt: null },
  ] },
} as never;
const lines = () => [...document.querySelectorAll(".usage-engine")].map((engine) => [engine.querySelector(".usage-name")!.textContent,
  [...engine.querySelectorAll(".usage-window")].map((line) => [line.querySelector(".usage-label")!.textContent, Boolean(line.querySelector(".usage-bar > span")), line.querySelector(".usage-percent")!.textContent, line.className.replace("usage-window", "").trim(), Boolean(line.querySelector(".usage-reset"))])]);

it("shows every limit each engine reports, one line each with its bar; attention from 75 %, danger from 90 %; when it resets from 75 %", () => {
  render(<UsageCard providers={providers} onRefresh={async () => undefined} />);
  expect(lines()).toEqual([
    ["Claude", [["5시간", true, "12%", "", false], ["주간", true, "78%", "high", true], ["주간 Fable", true, "93%", "full", true]]],
    ["Codex", [["5시간", true, "12%", "", false], ["주간 Opus", true, "78%", "high", false]]],
  ]);
  expect(document.body.textContent).not.toContain("·");
});

it("창 아래 줄: each engine's limits in one row; a click opens the full card", () => {
  render(<UsageLine providers={providers} onRefresh={async () => undefined} />);
  expect(document.querySelectorAll(".usage-line .usage-window")).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
  expect(document.querySelector(".usage-line-pop .usage-card")).toBeTruthy();
});

it("사용 한도 표시: an old record is 목록 칸 아래", () => {
  expect([readUsagePlace(undefined), readUsagePlace("x"), readUsagePlace("bottom"), readUsagePlace("hidden")]).toEqual(["list", "list", "bottom", "hidden"]);
});

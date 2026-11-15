// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attributionOf } from "../../licences.ts";
import { DOORY_ATTRIBUTION, LAUNCH_CREDIT_MIN_MS, LaunchCredit, resetLaunchCredit } from "./LaunchCredit.tsx";

// vendor/doory/LICENSE (Attribution Assurance License) clause 2: at each launch, a prominent display of
// the author's name, professional identification and URL. The line shows at launch on whatever screen
// the app opens, stays at least 10 s and until the person's first navigation (or its own 닫기), once.

beforeEach(() => { vi.useFakeTimers({ now: 1_000_000, toFake: ["setTimeout", "clearTimeout", "Date"] }); resetLaunchCredit(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const line = () => screen.queryByRole("note", { name: "디자인 편집기 저작자 표시" });
const later = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

it("carries the licence's three items verbatim, after the Korean lead", () => {
  const licence = readFileSync("vendor/doory/LICENSE", "utf8");
  expect(attributionOf(licence)).toEqual(DOORY_ATTRIBUTION);
  render(<LaunchCredit place="new:home" />);
  expect(line()!.textContent).toBe(`디자인 편집기에 쓴 오픈소스:${DOORY_ATTRIBUTION.name}, ${DOORY_ATTRIBUTION.role}, ${DOORY_ATTRIBUTION.url}`);
  expect(screen.getByRole("link", { name: DOORY_ATTRIBUTION.url }).getAttribute("href")).toBe(DOORY_ATTRIBUTION.url);
});

it.each([["home", "new:{\"kind\":\"new\",\"folderId\":null}"], ["a conversation", "work:{\"kind\":\"work\"}"], ["a document", "document:{\"kind\":\"document\",\"artifactId\":\"a1\",\"proposalId\":null}"]])(
  "shows at launch when the app opens on %s, and only once in that launch", (_name, place) => {
    const { rerender } = render(<LaunchCredit place={place} />);
    expect(line()).not.toBeNull();
    // The person moves on after the minimum: the line leaves …
    later(LAUNCH_CREDIT_MIN_MS + 1_000);
    expect(line()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    rerender(<LaunchCredit place="project:other" />);
    expect(line()).toBeNull();
    // … and does not come back in the same launch, whatever opens next.
    cleanup();
    render(<LaunchCredit place={place} />);
    expect(line()).toBeNull();
    // A new launch shows it again.
    resetLaunchCredit();
    cleanup();
    render(<LaunchCredit place={place} />);
    expect(line()).not.toBeNull();
  });

it("stays at least 10 seconds even when the person navigates at once, then leaves", () => {
  const { rerender } = render(<LaunchCredit place="new:home" />);
  later(2_000);
  fireEvent.pointerDown(document.body);
  rerender(<LaunchCredit place="work:s1" />);
  later(LAUNCH_CREDIT_MIN_MS - 2_000 - 1);
  expect(line()).not.toBeNull();
  later(1);
  expect(line()).toBeNull();
});

it("stays past 10 seconds until the first navigation", () => {
  const { rerender } = render(<LaunchCredit place="work:s1" />);
  later(60_000);
  expect(line()).not.toBeNull();
  rerender(<LaunchCredit place="work:s1" />);
  expect(line()).not.toBeNull();
  fireEvent.keyDown(window, { key: "ArrowDown" });
  rerender(<LaunchCredit place="document:d1" />);
  expect(line()).toBeNull();
});

it("does not count the app settling on its first screen as the person's navigation", () => {
  const { rerender } = render(<LaunchCredit place="new:home" />);
  // The last screen restored right after launch, nobody touched anything.
  rerender(<LaunchCredit place="work:last" />);
  later(LAUNCH_CREDIT_MIN_MS * 3);
  expect(line()).not.toBeNull();
});

it("closes with its own 닫기 and stays closed for the launch", () => {
  render(<LaunchCredit place="new:home" />);
  fireEvent.click(screen.getByRole("button", { name: "저작자 표시 닫기" }));
  expect(line()).toBeNull();
  cleanup();
  render(<LaunchCredit place="document:d1" />);
  expect(line()).toBeNull();
});

// Tech review 3 (mutants that survived): the 10 s as a number of the licence reading, the settling time, the composer's room.
it("stays 9,999 ms and leaves at 10,000 ms when the person navigated at once (the number itself, not the constant)", () => {
  const { rerender } = render(<LaunchCredit place="new:home" />);
  later(2_000);
  fireEvent.keyDown(window, { key: "Enter" });
  rerender(<LaunchCredit place="work:s1" />);
  later(9_999 - 2_000);
  expect(line()).not.toBeNull();
  later(1);
  expect(line()).toBeNull();
});

it("does not count a key pressed while the app is still settling (its first 1.5 s) as the person moving on", () => {
  const { rerender } = render(<LaunchCredit place="new:home" />);
  later(500);
  fireEvent.keyDown(window, { key: "Enter" });
  rerender(<LaunchCredit place="work:last" />);
  later(30_000);
  expect(line()).not.toBeNull();
});

it("takes real room under the panes: its height goes to the parent, whose margin keeps the composer clear", () => {
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () { return { height: 33, width: 800, top: 0, left: 0, right: 800, bottom: 33, x: 0, y: 0, toJSON() {} } as DOMRect; };
  try {
    const parent = document.createElement("div"); document.body.append(parent);
    const view = render(<LaunchCredit place="new:home" />, { container: parent });
    expect(parent.style.getPropertyValue("--launch-credit-h")).toBe("33px");
    view.unmount();
    expect(parent.style.getPropertyValue("--launch-credit-h")).toBe("");
    parent.remove();
  } finally { Element.prototype.getBoundingClientRect = rect; }
  expect(readFileSync("apps/web/src/styles/launch-credit.css", "utf8")).toMatch(/margin-bottom: var\(--launch-credit-h/);
});

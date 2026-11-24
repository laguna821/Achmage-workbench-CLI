// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocContext, type DocActions } from "./DocCards.tsx";
import { AnswerLink } from "./Transcript.tsx";

// 0.5.6: a file link in an answer, on a phone joined to the PC, opens its document in the app (DocActions.openLink);
// a web link, or any link on the PC (no openLink), is left to the browser as before.
afterEach(cleanup);
const mount = (openLink?: DocActions["openLink"]) => render(
  <DocContext.Provider value={{ state: {} as never, actions: { openLink } as unknown as DocActions }}>
    <AnswerLink href="/home/kim/강의/슬라이드-구성.md">슬라이드 구성</AnswerLink>
  </DocContext.Provider>);

it("on a phone: the file link is opened by the app, not followed", () => {
  const openLink = vi.fn(() => true);
  mount(openLink);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(screen.getByText("슬라이드 구성"), event);
  expect(openLink).toHaveBeenCalledWith("/home/kim/강의/슬라이드-구성.md");
  expect(event.defaultPrevented).toBe(true);
});

it("a link the app does not take (a web link; the PC) is followed as before", () => {
  mount(vi.fn(() => false));
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(screen.getByText("슬라이드 구성"), event);
  expect(event.defaultPrevented).toBe(false);
  cleanup(); mount(undefined);
  const again = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(screen.getByText("슬라이드 구성"), again);
  expect(again.defaultPrevented).toBe(false);
  // The PC draws the link exactly as before 0.5.6 (no target of its own; the app handles link clicks).
  expect(screen.getByText("슬라이드 구성").getAttribute("target")).toBeNull();
});

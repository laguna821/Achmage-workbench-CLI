// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ViewsSection } from "./ViewsSection.tsx";

vi.mock("./PkmContext.tsx", () => ({ usePkm: () => ({ pkmState: { views: [] }, target: null, setDialog: () => {} }) }));
afterEach(cleanup);

// Technical review (MINOR): the two icon keys beside 저장한 보기 had only a tooltip; each is named.
it("the keys beside 저장한 보기 are named, with tooltips", () => {
  render(<ViewsSection openMenu={() => undefined} />);
  const section = screen.getByRole("region", { name: "저장한 보기" });
  const keys = [...section.querySelectorAll<HTMLButtonElement>(".side-tools button")];
  expect(keys.map((key) => key.getAttribute("aria-label"))).toEqual(["새 보기 만들기", "저장한 보기 메뉴"]);
  expect(keys.every((key) => key.title.length > 0)).toBe(true);
});

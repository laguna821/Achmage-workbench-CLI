import { describe, expect, it } from "vitest";
import type { MenuEntry } from "../ContextMenu.tsx";
import { renameFirst } from "./menu-order.ts";

const item = (label: string): MenuEntry => ({ kind: "item", label, onSelect: () => {} });
const labels = (items: MenuEntry[]) => items.map((entry) => (entry.kind === "separator" ? "—" : "label" in entry ? entry.label : "?"));

describe("a row's menu under the hand (the owner, 2026-11-14)", () => {
  it("puts 이름 바꾸기 first, then the row's items as they were", () => {
    expect(labels(renameFirst([item("열기"), item("오른쪽에 열기"), item("이름 바꾸기"), { kind: "separator" }, item("고정"), { kind: "separator" }, item("보관")])))
      .toEqual(["이름 바꾸기", "—", "열기", "오른쪽에 열기", "—", "고정", "—", "보관"]);
  });

  it("leaves a menu without a rename (a document) as it is", () => {
    const menu = [item("열기"), { kind: "separator" } as MenuEntry, item("휴지통으로 옮기기")];
    expect(renameFirst(menu)).toBe(menu);
  });
});

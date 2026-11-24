import { describe, expect, it, vi } from "vitest";
import type { Work } from "@workbench/contracts";
import type { MenuEntry } from "./components/ContextMenu.tsx";
import { homeMenu } from "./messenger-home.ts";

// A messenger's own place ("텔레그램 대화", `Work.messengerHome`): 0.5.6 lets the person rename it; its
// place (folder, 보관, 삭제) is still kept while its messenger is registered. A renamed home's menu
// offers 이름 지우기, which brings back the name it was made with.

const home = (title: string, registered = true) => ({ id: "h", title, messengerHome: { kind: "telegram", registered } }) as unknown as Work;
const ITEMS: MenuEntry[] = [
  { kind: "item", label: "열기", onSelect: () => {} },
  { kind: "item", label: "이름 바꾸기", onSelect: () => {} },
  { kind: "item", label: "고정", onSelect: () => {} },
  { kind: "submenu", label: "옮기기", items: [] },
  { kind: "item", label: "보관", onSelect: () => {} },
  { kind: "item", label: "프로젝트 삭제…", onSelect: () => {} },
];
const labels = (items: MenuEntry[]) => items.flatMap((entry) => (entry.kind === "item" || entry.kind === "submenu" ? [`${entry.label}${entry.disabled ? " (꺼짐)" : ""}`] : []));

describe("a messenger home's menu", () => {
  it("keeps 이름 바꾸기 on and the place off while its messenger is registered", () => {
    expect(labels(homeMenu(home("텔레그램 대화"), ITEMS))).toEqual(["열기", "이름 바꾸기", "고정", "옮기기 (꺼짐)", "보관 (꺼짐)", "프로젝트 삭제… (꺼짐)"]);
  });

  it("a renamed home offers 이름 지우기 right after 이름 바꾸기, saying the name it goes back to; once only", () => {
    const clear = vi.fn();
    const items = homeMenu(home("Achmage 봇 1호기"), homeMenu(home("Achmage 봇 1호기"), ITEMS, clear), clear);
    expect(labels(items)).toEqual(["열기", "이름 바꾸기", "이름 지우기", "고정", "옮기기 (꺼짐)", "보관 (꺼짐)", "프로젝트 삭제… (꺼짐)"]);
    const entry = items[2] as Extract<MenuEntry, { kind: "item" }>;
    expect(entry.hint).toBe("'텔레그램 대화'로");
    entry.onSelect();
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("no 이름 지우기 under the default name, nor without a way to clear it, nor for a project", () => {
    expect(labels(homeMenu(home("텔레그램 대화"), ITEMS, () => {}))).not.toContain("이름 지우기");
    expect(labels(homeMenu(home("Achmage 봇 1호기"), ITEMS))).not.toContain("이름 지우기");
    expect(homeMenu({ id: "p", title: "강의" } as Work, ITEMS, () => {})).toBe(ITEMS);
  });
});

import { describe, expect, it } from "vitest";
import { comboLabel, comboOf, shortcutsOf, usableCombo } from "./shortcuts.ts";

const press = (key: string, code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("keyboard shortcuts", () => {
  it("read a press by its physical key (a Korean input mode gives ㅏ for K), Cmd as Ctrl", () => {
    expect(comboOf(press("ㅏ", "KeyK", { ctrlKey: true }))).toBe("Ctrl+K");
    expect(comboOf(press("k", "KeyK", { metaKey: true }))).toBe("Ctrl+K");
    expect(comboOf(press("F", "KeyF", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+F");
    expect(comboOf(press("1", "Digit1", { altKey: true }))).toBe("Alt+1");
    expect(comboOf(press("F2", "F2"))).toBe("F2");
    expect(comboOf(press("Control", "ControlLeft", { ctrlKey: true }))).toBeNull();
  });

  it("take only combinations that do not get in the way of typing", () => {
    expect(usableCombo("Ctrl+P")).toBe(true);
    expect(usableCombo("Alt+Shift+O")).toBe(true);
    expect(usableCombo("F5")).toBe(true);
    expect(usableCombo("Shift+K")).toBe(false);
    expect(usableCombo("K")).toBe(false);
  });

  it("use the person's combinations, else the app's, and show them as key caps", () => {
    expect(shortcutsOf({})).toEqual({ palette: "Ctrl+K", content: "Ctrl+Shift+F", newWork: "Ctrl+N", otherPane: "F6", navigator: "Ctrl+Shift+E" });
    expect(shortcutsOf({ shortcuts: { palette: "Ctrl+P", content: "K", newWork: 3, navigator: "Alt+N" } })).toEqual({ palette: "Ctrl+P", content: "Ctrl+Shift+F", newWork: "Ctrl+N", otherPane: "F6", navigator: "Alt+N" });
    expect(comboLabel("Ctrl+Shift+F")).toBe("Ctrl Shift F");
  });
});

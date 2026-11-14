import { describe, expect, it, vi } from "vitest";
import { EditorRegistry, leaveEditors, removeAfterSaving } from "./doc-editors.ts";

// Removing a document open in an editor goes through that editor's own leave path (the save-on-
// leave guard closing its tab uses): the removal is sent only after every editor answered "saved
// or nothing to save" in time. A late flag is never trusted.

const later = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const editor = {
  clean: () => async () => undefined,
  dirtyFails: () => async () => { throw new Error("저장하지 못했습니다"); },
  late: () => async () => later(200),
  never: () => () => new Promise<void>(() => undefined),
};

describe("asking the open editors", () => {
  it("knows which views are dirty, and which cannot tell (treated as dirty)", () => {
    const editors = new EditorRegistry();
    editors.set("doc", "text", { dirty: () => false });
    editors.set("doc", "slides", { dirty: () => "unknown" });
    editors.set("other", "x", { dirty: () => true });
    expect(editors.states("doc").sort()).toEqual([false, "unknown"]);
    editors.set("doc", "slides", null);
    expect(editors.states("doc")).toEqual([false]);
  });

  it("proceeds only when every editor answers in time", async () => {
    await expect(leaveEditors([editor.clean(), editor.clean()], 50)).resolves.toBeUndefined();
    await expect(leaveEditors([editor.clean(), editor.dirtyFails()], 50)).rejects.toThrow(/저장하지 못했습니다/);
    await expect(leaveEditors([editor.late()], 50)).rejects.toThrow(/저장을 확인하지 못해/);
    await expect(leaveEditors([editor.never()], 50)).rejects.toThrow(/저장을 확인하지 못해/);
  });
});

describe("removing after the editors left", () => {
  it("asks when an editor is dirty or cannot tell, leaves every editor, and only then sends", async () => {
    const order: string[] = [];
    const send = vi.fn(async () => { order.push("send"); return "sent"; });
    const leave = vi.fn(async () => { order.push("leave"); });
    const ask = vi.fn(async () => true);
    expect(await removeAfterSaving([false], ask, leave, send)).toBe("sent");
    expect(ask).not.toHaveBeenCalled();
    expect(order).toEqual(["leave", "send"]);
    expect(await removeAfterSaving(["unknown"], ask, leave, send)).toBe("sent");
    expect(ask).toHaveBeenCalledWith(false);
    await removeAfterSaving([true], ask, leave, send);
    expect(ask).toHaveBeenLastCalledWith(true);
  });

  it("sends nothing on 취소, on a failed save, or when an editor does not answer", async () => {
    const send = vi.fn(async () => "sent");
    expect(await removeAfterSaving([true], async () => false, async () => undefined, send)).toBe("cancelled");
    await expect(removeAfterSaving([false], async () => true, () => leaveEditors([editor.dirtyFails()], 50), send)).rejects.toThrow();
    await expect(removeAfterSaving(["unknown"], async () => true, () => leaveEditors([editor.never()], 50), send)).rejects.toThrow(/저장을 확인하지 못해/);
    expect(send).not.toHaveBeenCalled();
  });
});

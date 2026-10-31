import { expect, it, vi } from "vitest";
import type { DesignDraft } from "@workbench/contracts";
import { DesignRecovery } from "./recovery";

const snapshot = (text: string, baseRevision = 1): DesignDraft => ({ artifactId: "a", viewId: "v", baseRevision, text, sha256: text, at: 1 });
function setup(recovered?: DesignDraft) {
  const keepDraft = vi.fn(async (_id: string, revision: number, text: string) => snapshot(text, revision));
  const removeDraft = vi.fn(async () => ({}));
  const onError = vi.fn();
  return { keepDraft, removeDraft, onError, recovery: new DesignRecovery({ gateway: { keepDraft, removeDraft }, artifactId: "a", original: "original", recovered, onError }) };
}
it("a save arriving during recovery upload clears only its matching snapshot", async () => {
  const { recovery, keepDraft, removeDraft } = setup();
  let finish!: (value: DesignDraft) => void;
  keepDraft.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = recovery.observe("first", 1, async () => "first");
  await vi.waitFor(() => expect(keepDraft).toHaveBeenCalledTimes(1));
  const saved = recovery.saved("first");
  const next = recovery.observe("second", 2, async () => "second");
  finish(snapshot("first"));
  await Promise.all([first, saved, next]);
  expect(removeDraft).toHaveBeenCalledWith("a", snapshot("first"));
  expect(removeDraft).toHaveBeenCalledTimes(1);
  expect(keepDraft).toHaveBeenLastCalledWith("a", 2, "second");
});
it("an old asset conversion cannot replace a newer edit", async () => {
  const { recovery, keepDraft } = setup();
  let finish!: (value: string) => void;
  const prepare = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const old = recovery.observe("old blob", 1, prepare);
  await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
  const next = recovery.observe("latest", 1, async () => "latest");
  finish("old durable");
  await Promise.all([old, next]);
  expect(keepDraft).toHaveBeenCalledTimes(1);
  expect(keepDraft).toHaveBeenCalledWith("a", 1, "latest");
});
it("saving before normalisation finishes never leaves a stale recovery dialog", async () => {
  const { recovery, keepDraft } = setup();
  let finish!: (value: string) => void;
  const prepare = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const pending = recovery.observe("blob", 1, prepare);
  await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
  const saved = recovery.saved("durable");
  finish("durable");
  await Promise.all([pending, saved]);
  expect(keepDraft).not.toHaveBeenCalled();
});
it("a successful descendant save clears the explicitly recovered version, and failed writes remain visible", async () => {
  const restored = snapshot("restored");
  const { recovery, keepDraft, removeDraft, onError } = setup(restored);
  keepDraft.mockRejectedValueOnce(new Error("disk full"));
  await recovery.observe("edit", 1, async () => "edit");
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  expect(removeDraft).not.toHaveBeenCalled();
  await recovery.saved("descendant");
  expect(removeDraft).toHaveBeenCalledWith("a", restored);
});
it("an in-flight autosave advances the base of a newer unsaved recovery without clearing it", async () => {
  const { recovery, keepDraft, removeDraft } = setup();
  await recovery.observe("newer edit", 1, async () => "newer edit");
  await recovery.saved("earlier edit", 2);
  expect(keepDraft).toHaveBeenLastCalledWith("a", 2, "newer edit");
  expect(removeDraft).not.toHaveBeenCalled();
});
it("saving a copy never clears edits made after the captured copy", async () => {
  const { recovery, removeDraft } = setup();
  await recovery.observe("copied", 1, async () => "copied");
  await recovery.observe("after copy", 1, async () => "after copy");
  await recovery.copied("copied");
  expect(removeDraft).not.toHaveBeenCalled();
  await recovery.copied("after copy");
  expect(removeDraft).toHaveBeenCalledWith("a", snapshot("after copy"));
});

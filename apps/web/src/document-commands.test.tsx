import { expect, it } from "vitest";
import { registerDocumentCommands, saveReferencedDocument } from "./document-commands.ts";

it("waits for the dirty editor's save and leaves clean readers alone", async () => {
  let resolve!: (revision: number) => void, cleanSaves = 0;
  const removeWriter = registerDocumentCommands("writer", { artifactId: "doc", dirty: () => true, save: () => new Promise((done) => { resolve = done; }) });
  const removeReader = registerDocumentCommands("reader", { artifactId: "doc", dirty: () => false, save: async () => { cleanSaves++; return 1; } });
  const pending = saveReferencedDocument("doc"); let complete = false;
  void pending.then(() => { complete = true; });
  await Promise.resolve(); expect(complete).toBe(false);
  resolve(2); expect(await pending).toBe(2); expect(cleanSaves).toBe(0);
  removeWriter(); removeReader();
});

it("refuses to send when a dirty editor loses permission or cannot save", async () => {
  const remove = registerDocumentCommands("failed", { artifactId: "doc", dirty: () => true, save: async () => null });
  await expect(saveReferencedDocument("doc")).rejects.toThrow(/저장하지 못해/);
  remove(); expect(await saveReferencedDocument("doc")).toBeUndefined();
});

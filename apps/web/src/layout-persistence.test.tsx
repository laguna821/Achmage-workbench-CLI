import { expect, it, vi } from "vitest";
import { LayoutPersistence } from "./layout-persistence.ts";
import type { WorkspaceLayoutRecord } from "@workbench/contracts";

it("serializes rapid saves against the acknowledged revision and does not overwrite after a conflict", async () => {
  let revision = 0;
  const api = {
    layout: vi.fn(async () => ({ record: { key: "global", revision, layout: {}, updatedAt: 0 } as WorkspaceLayoutRecord })),
    saveLayout: vi.fn(async (key: string, expected: number, layout: Record<string, unknown>) => {
      await Promise.resolve();
      if (expected !== revision) throw new Error("conflict");
      return { record: { key, revision: ++revision, layout, updatedAt: 0 } };
    }),
  };
  const store = new LayoutPersistence(api);
  await store.read("global");
  await Promise.all([store.write("global", { marker: 1 }), store.write("global", { marker: 2 })]);
  expect(api.saveLayout.mock.calls.map((call) => call[1])).toEqual([0, 1]);
  revision++;
  await expect(store.write("global", { marker: 3 })).rejects.toThrow("conflict");
  await expect(store.write("global", { marker: 4 })).rejects.toThrow("conflict");
  expect(api.saveLayout).toHaveBeenCalledTimes(3);
  await store.read("global");
  await store.write("global", { marker: 4 });
  expect(api.saveLayout.mock.calls.at(-1)![1]).toBe(3);
});

import { describe, expect, it } from "vitest";
import type { VaultFolder } from "@workbench/contracts";
import { countLabel, groupRuns, obsidianUrl, vaultRows } from "./pkm.ts";

const folder = (path: string, children: VaultFolder[] = [], own = 1, below = 0): VaultFolder => ({
  path,
  name: path.split("/").pop() ?? path,
  own,
  below,
  color: { light: null, dark: null },
  background: { light: null, dark: null },
  icon: null,
  pinned: 0,
  children,
});

describe("vault rows", () => {
  const root = folder("", [folder("A", [folder("A/a1"), folder("A/a2")]), folder("B"), folder("C", [folder("C/c1")])]);

  it("lists top folders and the children of unfolded ones only", () => {
    expect(vaultRows(root, new Set()).map((row) => row.folder.path)).toEqual(["A", "B", "C"]);
    const rows = vaultRows(root, new Set(["A"]));
    expect(rows.map((row) => `${row.folder.path}:${row.depth}`)).toEqual(["A:0", "A/a1:1", "A/a2:1", "B:0", "C:0"]);
    expect(rows[0]!.open).toBe(true);
    expect(rows.find((row) => row.folder.path === "C")!.expandable).toBe(true);
  });

  it("puts consecutive folders of one border group into one block", () => {
    const groups = [
      { id: "g1", folders: ["A", "B"] },
      { id: "g2", folders: ["D"] },
    ];
    const blocks = ["A", "B", "C", "D", "E"].map((path) => ({ folder: folder(path) }));
    const runs = groupRuns(blocks, groups);
    expect(runs.map((run) => [run.groupId, run.blocks.map((block) => block.folder.path)])).toEqual([
      ["g1", ["A", "B"]],
      [null, ["C"]],
      ["g2", ["D"]],
      [null, ["E"]],
    ]);
    // A folder of another group in between starts a new block.
    const split = groupRuns(["A", "D", "B"].map((path) => ({ folder: folder(path) })), groups);
    expect(split.map((run) => run.groupId)).toEqual(["g1", "g2", "g1"]);
  });

  it("reads counts as '현재 · 하위' and builds obsidian links", () => {
    expect(countLabel({ own: 3, below: 12 })).toBe("3 · 12");
    expect(countLabel({ own: 2, below: 0 })).toBe("2");
    expect(countLabel({ own: 0, below: 0 })).toBe("");
    expect(obsidianUrl("/v/My Vault", "01. Inbox/a b.md")).toBe(`obsidian://open?path=${encodeURIComponent("/v/My Vault/01. Inbox/a b.md")}`);
  });
});

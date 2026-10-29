import { describe, expect, it } from "vitest";
import type { VaultFolder } from "@workbench/contracts";
import { countLabel, dateGroup, expandablePaths, groupCards, groupRuns, noteSection, obsidianUrl, vaultMarkdown, vaultRows } from "./pkm.ts";

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

  it("unfolds every folder with subfolders for 전체 펼치기 (leaves and the root are not listed)", () => {
    const deep = folder("", [folder("A", [folder("A/a1", [folder("A/a1/x")]), folder("A/a2")]), folder("B")]);
    expect(expandablePaths(deep)).toEqual(["A", "A/a1"]);
    expect(vaultRows(deep, new Set(expandablePaths(deep))).map((row) => row.folder.path)).toEqual(["A", "A/a1", "A/a1/x", "A/a2", "B"]);
    expect(expandablePaths(null)).toEqual([]);
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

describe("cards and notes", () => {
  const now = new Date(2026, 9, 28, 15, 0).getTime();
  const day = 86_400_000;

  it("groups cards by date the way Notebook Navigator does, pinned first", () => {
    expect(dateGroup({ pinned: true, date: now }, now)).toBe("고정");
    expect(dateGroup({ pinned: false, date: now - 3600_000 }, now)).toBe("오늘");
    expect(dateGroup({ pinned: false, date: now - day }, now)).toBe("어제");
    expect(dateGroup({ pinned: false, date: now - 5 * day }, now)).toBe("지난 7일");
    expect(dateGroup({ pinned: false, date: now - 20 * day }, now)).toBe("지난 30일");
    expect(dateGroup({ pinned: false, date: new Date(2026, 6, 3).getTime() }, now)).toBe("2026년 7월");
    expect(dateGroup({ pinned: false, date: null }, now)).toBe("날짜 없음");
    const groups = groupCards([{ pinned: true, date: 1 }, { pinned: false, date: now }, { pinned: false, date: now - 60_000 }, { pinned: false, date: now - day }], now);
    expect(groups.map((group) => [group.label, group.cards.length])).toEqual([["고정", 1], ["오늘", 2], ["어제", 1]]);
  });

  it("turns Obsidian links and pictures into links and images the mirror serves", () => {
    const markdown = vaultMarkdown(
      "![[pic.png|300]] and ![alt](sub/b.jpg) and ![w](https://x.org/c.png)\n[[a|에이]] [[없음]] %%숨김%%\n> [!NOTE] 알림\n" +
        '![[a]]\n\n![[a#목표|별칭]]\n\n![[없는 노트]]\n\n<img src="sub/b.jpg" width="300"> <img src="https://x.org/d.png">',
      { links: { a: "01. Inbox/a (1).md", 없음: null, "없는 노트": null }, embeds: { "pic.png": "att/pic.png", "sub/b.jpg": "n/sub/b.jpg" } },
      3,
    );
    expect(markdown).toContain("![pic.png|300](/api/pkm/vault/image?path=att%2Fpic.png&v=3)");
    expect(markdown).toContain("![alt](/api/pkm/vault/image?path=n%2Fsub%2Fb.jpg&v=3)");
    expect(markdown).toContain("![w](https://x.org/c.png)");
    expect(markdown).toContain("[에이](vault-note:01.%20Inbox%2Fa%20%281%29.md)");
    expect(markdown).toContain(" 없음 ");
    expect(markdown).not.toContain("숨김");
    // Callouts are drawn by the Markdown view, so the text keeps them as written.
    expect(markdown).toContain("> [!NOTE] 알림");
    expect(markdown).toContain("[a](vault-embed:01.%20Inbox%2Fa%20%281%29.md)");
    expect(markdown).toContain("[별칭](vault-embed:01.%20Inbox%2Fa%20%281%29.md#%EB%AA%A9%ED%91%9C)");
    expect(markdown).toContain("*(노트 없음: 없는 노트)*");
    expect(markdown).toContain('<img src="/api/pkm/vault/image?path=n%2Fsub%2Fb.jpg&v=3" width="300">');
    expect(markdown).toContain('<img src="https://x.org/d.png">');
  });

  it("finds the part of a note a ![[note#제목]] or ![[note#^id]] points at", () => {
    const body = ["# 수업", "소개", "## 목표", "목표 하나", "```", "# 코드 속 제목", "```", "### 세부", "세부 내용", "## 평가", "평가 기준 ^grade-1", ""].join("\n");
    expect(noteSection(body, null)).toBe(body);
    expect(noteSection(body, "목표")).toBe(["## 목표", "목표 하나", "```", "# 코드 속 제목", "```", "### 세부", "세부 내용"].join("\n"));
    expect(noteSection(body, "수업#평가")).toBe(["## 평가", "평가 기준 ^grade-1", ""].join("\n"));
    expect(noteSection(body, "^grade-1")).toBe("평가 기준");
    expect(noteSection(body, "없는 제목")).toBe("");
  });
});

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { READ_PLUGIN_SETTINGS, VaultMirror, hiddenBy, iconFor, safeColor } from "./vault.ts";

// A small vault in a temporary folder; the user's own vault is never touched by tests.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, text = "") {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

export function fixtureVault() {
  const root = mkdtempSync(join(tmpdir(), "wb-vault-"));
  roots.push(root);
  put(root, ".obsidian/app.json", "{}");
  put(
    root,
    ".obsidian/plugins/notebook-navigator/data.json",
    JSON.stringify({
      vaultProfile: "default",
      vaultProfiles: [{ id: "default", hiddenFolders: ["/90.*"], hiddenFileNames: [], shortcuts: [{ type: "note", path: "01. Inbox/b.md" }] }],
      folderColors: { "/": "#ffb2cb", "20. Information (I)": "#bd9aaf", "01. Inbox": "not a colour;}" },
      folderIcons: { "01. Inbox": "material-icons:email", "20. Information (I)": "book" },
      pinnedNotes: { "01. Inbox/a.md": { folder: true, tag: false, property: false } },
      tagColors: { Work: "#ff0000", bad: "url(javascript:alert(1))" },
      inheritFolderColors: true,
      someOtherSetting: "kept out",
    }),
  );
  put(
    root,
    ".obsidian/plugins/achmage-nn-border-addon/data.json",
    JSON.stringify({
      folderBorders: { "/": { startColor: "#4a70b7", endColor: "#2cb3b3", radius: 6, darkStartColor: "#ffb2cb", darkEndColor: "#005bac" } },
      borderGroups: [{ id: "g1", name: "Group 1", folders: ["00. DIKM 이란", "01. Inbox", "20. Information (I)"], style: { startColor: "#7abfc3", endColor: "#77a1d6", darkStartColor: "#d58ead", darkEndColor: null } }],
      folderColorOverrides: { "20. Information (I)": { light: { color: "#1c6c75" } } },
      showFolderBorders: true,
      showGroupBorders: true,
      suppressNestedBorders: true,
    }),
  );
  // Another plugin's settings hold a secret; the mirror must never open them.
  put(root, ".obsidian/plugins/cmds-zotero/data.json", JSON.stringify({ apiKey: "SECRET-TOKEN" }));
  put(root, "00. DIKM 이란/intro.md", "# DIKM");
  put(root, "01. Inbox/a.md", "---\ntitle: A\n---\nhello");
  put(root, "01. Inbox/b.md", "b");
  put(root, "20. Information (I)/x.md", "x");
  put(root, "20. Information (I)/201. Topics/t1.md", "t1");
  put(root, "90. Settings/91. Templates/tpl.md", "tpl");
  put(root, ".trash/old.md", "old");
  put(root, "attachments/pic.png", "png");
  put(root, "References/map.canvas", "{}");
  put(root, "root.md", "root");
  return root;
}

function listing(root: string) {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stats = statSync(full);
        out.push(`${full}:${stats.mtimeMs}:${stats.size}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

const until = async (what: () => boolean, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (what()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
};

describe("vault mirror", () => {
  it("counts notes per folder (own · below), leaving out dot folders and hidden folders", () => {
    const root = fixtureVault();
    const mirror = new VaultMirror(() => undefined);
    mirror.attach(root);
    const tree = mirror.tree();
    const names = tree.root!.children.map((folder) => folder.name);
    expect(names).toEqual(["00. DIKM 이란", "01. Inbox", "20. Information (I)", "attachments", "References"]);
    const info = tree.root!.children.find((folder) => folder.name === "20. Information (I)")!;
    expect([info.own, info.below]).toEqual([1, 1]);
    expect([tree.root!.own, tree.root!.below]).toEqual([1, 6]);
    // The hidden folder's template is not counted as a note of the vault.
    expect(tree.status.notes).toBe(7);
    mirror.close();
  });

  it("draws folders with Notebook Navigator's colours and icons and the add-on's per-theme overrides", () => {
    const root = fixtureVault();
    const mirror = new VaultMirror(() => undefined);
    mirror.attach(root);
    const tree = mirror.tree();
    const find = (name: string) => tree.root!.children.find((folder) => folder.name === name)!;
    const info = find("20. Information (I)");
    expect(info.color).toEqual({ light: "#1c6c75", dark: "#bd9aaf" });
    // Inherited by its subfolder in both themes.
    expect(info.children[0]!.color).toEqual({ light: "#1c6c75", dark: "#bd9aaf" });
    // A broken colour is dropped; the folder takes the vault's colour instead.
    expect(find("01. Inbox").color).toEqual({ light: "#ffb2cb", dark: "#ffb2cb" });
    expect(find("01. Inbox").icon).toBe("mail");
    expect(info.icon).toBe("book");
    expect(find("01. Inbox").pinned).toBe(1);
    expect(tree.pinned).toEqual([{ path: "01. Inbox/a.md", title: "a" }]);
    expect(tree.shortcuts).toEqual([{ path: "01. Inbox/b.md", kind: "note", title: "b" }]);
    expect(tree.tagColors).toEqual({ work: "#ff0000" });
    mirror.close();
  });

  it("reads the border add-on's groups with separate dark colours", () => {
    const root = fixtureVault();
    const mirror = new VaultMirror(() => undefined);
    mirror.attach(root);
    const borders = mirror.tree().borders!;
    expect(borders.groups[0]!.folders).toContain("01. Inbox");
    expect(borders.groups[0]!.style.start).toEqual({ light: "#7abfc3", dark: "#d58ead" });
    // A dark start colour without a dark end: a plain border in the dark theme.
    expect(borders.groups[0]!.style.end).toEqual({ light: "#77a1d6", dark: null });
    expect(borders.folders["/"]!.radius).toBe(6);
    mirror.close();
  });

  it("reads only the two plugin settings it draws from, and only their display keys", () => {
    expect(READ_PLUGIN_SETTINGS).toEqual(["notebook-navigator", "achmage-nn-border-addon"]);
    const root = fixtureVault();
    const mirror = new VaultMirror(() => undefined);
    mirror.attach(root);
    const shown = JSON.stringify(mirror.tree());
    expect(shown).not.toContain("SECRET-TOKEN");
    expect(shown).not.toContain("kept out");
    mirror.close();
  });

  it("never resolves a path outside the vault or into its dot folders", () => {
    const root = fixtureVault();
    const mirror = new VaultMirror(() => undefined);
    mirror.attach(root);
    expect(mirror.resolve("01. Inbox/a.md")).toBe(join(root, "01. Inbox/a.md"));
    for (const bad of ["../x.md", "01. Inbox/../../x", ".obsidian/plugins/cmds-zotero/data.json", ".trash/old.md"]) expect(() => mirror.resolve(bad)).toThrow();
    mirror.close();
  });

  it("follows changes on disk (debounced) and never writes into the vault", async () => {
    const root = fixtureVault();
    const before = listing(root);
    const versions: number[] = [];
    const mirror = new VaultMirror((version) => versions.push(version), { debounceMs: 40 });
    mirror.attach(root);
    mirror.tree();
    mirror.rescan();
    expect(listing(root)).toEqual(before);
    const first = versions.at(-1)!;
    put(root, "01. Inbox/c.md", "new");
    put(root, "01. Inbox/d.md", "new");
    expect(await until(() => mirror.status().notes === 9)).toBe(true);
    expect(versions.at(-1)!).toBeGreaterThan(first);
    // Two files in quick succession: one rescan, not one per file.
    expect(versions.length - versions.indexOf(first)).toBeLessThanOrEqual(3);
    mirror.close();
  });

  it("rejects folders that are not vaults", () => {
    const plain = mkdtempSync(join(tmpdir(), "wb-plain-"));
    roots.push(plain);
    const mirror = new VaultMirror(() => undefined);
    expect(() => mirror.attach(plain)).toThrow(/옵시디언/);
    expect(() => mirror.attach("relative/path")).toThrow();
    mirror.close();
  });
});

describe("settings helpers", () => {
  it("matches Notebook Navigator hidden-folder patterns", () => {
    expect(hiddenBy(["/90.*"], "90. Settings")).toBe(true);
    expect(hiddenBy(["/90.*"], "a/90. Settings")).toBe(false);
    expect(hiddenBy(["Attach*"], "x/Attachments")).toBe(true);
    expect(hiddenBy(["/80*"], "80. References")).toBe(true);
  });

  it("keeps only plain colours and maps icon ids", () => {
    expect(safeColor("#ffb2cb")).toBe("#ffb2cb");
    expect(safeColor("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(safeColor("red;background:url(x)")).toBeNull();
    expect(iconFor("material-icons:run_circle")).toBe("run");
    expect(iconFor("lucide-book-open")).toBe("book");
    expect(iconFor("material-icons:unknown_thing")).toBeNull();
  });
});

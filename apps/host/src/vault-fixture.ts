import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A small Obsidian vault for unit tests, made in a folder the test gives (a temporary one).

export function put(root: string, path: string, text: string | Buffer = "") {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

export function makeFixtureVault(root: string) {
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

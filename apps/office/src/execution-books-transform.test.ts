// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { expect, it } from "vitest";
import { patchBookExecutions } from "../execution-patch-books.ts";
import { patchOfficeSkillConversation } from "../skill-conversation-patch.ts";

it("guards and transpiles every touched pinned original without altering unrelated modules", async () => {
  const root = fileURLToPath(new URL("../../../vendor/ieumoffice", import.meta.url));
  const module = fileURLToPath(new URL("./execution-adapter.ts", import.meta.url));
  const files = [
    "apps/sheets/src/renderer/App.tsx",
    "apps/pdf/src/renderer/ai/AiPanel.tsx",
    "apps/epub/src/renderer/App.tsx",
    "apps/epub/src/renderer/ai/AiPanel.tsx",
    "apps/epub/src/renderer/ai/book-tools.ts",
    "apps/epub/src/renderer/translate/BookTranslation.tsx",
    "apps/epub/src/renderer/translate/BookTranslateDialog.tsx",
  ];
  for (const relative of files) {
    const id = `${root}/${relative}`;
    const original = await readFile(id, "utf8");
    const prepared = patchOfficeSkillConversation(original, id, root);
    const patched = patchBookExecutions(prepared, id, root, module);
    expect(patched, relative).not.toBe(prepared);
    await transform(patched, { loader: relative.endsWith("tsx") ? "tsx" : "ts", sourcefile: relative, target: "es2022" });
  }
  expect(patchBookExecutions("unrelated", `${root}/unrelated.ts`, root, module)).toBe("unrelated");
  const pdf = `${root}/apps/pdf/src/renderer/ai/AiPanel.tsx`;
  expect(() => patchBookExecutions("upstream boundary moved", pdf, root, module)).toThrow("boundary changed");
});

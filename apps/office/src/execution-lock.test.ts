// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { Editor } from "../../../vendor/ieumoffice/node_modules/@tiptap/core/dist/index.js";
import StarterKit from "../../../vendor/ieumoffice/node_modules/@tiptap/starter-kit/dist/index.js";
import { patchOfficeExecution } from "../execution-patch.ts";

// U38 finding 3: the rich Markdown editor counted every TipTap "update" as an edit, and locking or
// unlocking it for the document AI (on opening, and on every poll of the executor) emitted one
// through setEditable — so an untouched document said 저장 안 됨 and its view stayed "unsaved" at the
// gateway (목록에서 빼기 → 409 document_unsaved). Locking must not look like an edit.
it("locking and unlocking the Markdown editor for its AI emits no update (no edit)", () => {
  const root = resolve("vendor/ieumoffice");
  const id = `${root}/apps/markdown/src/renderer/ai/AiPanel.tsx`;
  const code = patchOfficeExecution(readFileSync(id, "utf8"), id, root, "/workbench/execution-adapter.ts");
  const body = /lock: \(locked\) => \{\n([\s\S]*?)\n {4}\},\n/.exec(code)?.[1];
  expect(body).toBeTruthy();
  const editor = new Editor({ element: document.createElement("div"), extensions: [StarterKit], content: "<p>그대로</p>" });
  let updates = 0;
  editor.on("update", () => { updates++; });
  const lock = new Function("depsRef", "document", `return (locked) => {\n${body}\n}`)({ current: { getEditor: () => editor } }, document) as (locked: boolean) => void;
  try {
    lock(true); expect(editor.isEditable).toBe(false);
    lock(false); expect(editor.isEditable).toBe(true);
    lock(false);
    expect(updates).toBe(0);
  } finally { editor.destroy(); }
});

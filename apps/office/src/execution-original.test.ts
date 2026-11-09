// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { Editor } from "../../../vendor/ieumoffice/node_modules/@tiptap/core/dist/index.js";
import StarterKit from "../../../vendor/ieumoffice/node_modules/@tiptap/starter-kit/dist/index.js";
import { Markdown } from "../../../vendor/ieumoffice/node_modules/@tiptap/markdown/dist/index.js";
import type { AgentLoopOptions } from "../../../vendor/ieumoffice/packages/agent-core/src/loop.ts";
import { WorkbenchAgentLoop, type OfficeRun } from "./office-agent.ts";

it("uses the original Markdown selection tool and serializer without changing the other matching paragraph", async () => {
  // Upstream UI is transpiled by the pinned Vite adapter, not the Workbench shim
  // type project. Load its real runtime while checking its public AgentSkill contract.
  const path = "../../../vendor/ieumoffice/apps/markdown/src/renderer/ai/markdown-skill.ts";
  const { createMarkdownSkill } = await import(/* @vite-ignore */ path) as { createMarkdownSkill(get: () => Editor): AgentLoopOptions["skill"] };
  const source = new Editor({ element: document.createElement("div"), extensions: [StarterKit, Markdown], content: "before\n\nbefore", contentType: "markdown" });
  source.commands.setTextSelection({ from: 1, to: 7 });
  const state = { document: source.getJSON(), selection: source.state.selection.toJSON() };
  const executor = new Editor({ element: document.createElement("div"), extensions: [StarterKit, Markdown], content: state.document });
  const Selection = source.state.selection.constructor as typeof source.state.selection.constructor & { fromJSON(doc: typeof executor.state.doc, json: unknown): typeof executor.state.selection };
  executor.view.dispatch(executor.state.tr.setSelection(Selection.fromJSON(executor.state.doc, state.selection)));
  const skill = createMarkdownSkill(() => executor);
  try {
    expect(await skill.buildContext?.()).toContain("User selection");
    const result = await skill.executeTool({ id: "replace", name: "apply_ops", input: { ops: [{ op: "replaceText", target: "selection", find: "before", replace: "after" }] } });
    expect(result.isError).toBeFalsy(); expect(result.mutated).toBe(true);
    expect(executor.getMarkdown()).toBe("after\n\nbefore");
    expect(source.getMarkdown()).toBe("before\n\nbefore");
  } finally { source.destroy(); executor.destroy(); }
});

it("detaches a closing view during handoff without starting or cancelling a second loop", async () => {
  let accept!: (run: OfficeRun) => void;
  const remote = { wait: vi.fn(async () => ({ text: "", cancelled: false, turnLimit: false })), cancel: vi.fn(), detach: vi.fn() };
  const stream = vi.fn(), finish = vi.fn(async () => {});
  const loop = new WorkbenchAgentLoop({ skill: { id: "fixture", systemPrompt: "", tools: [], executeTool: () => ({ summary: "", output: "" }) }, transport: { stream } }, {
    attach: () => () => {}, begin: () => new Promise(resolve => { accept = resolve; }),
  });
  loop.run("original request"); loop.detach();
  accept({ history: [], remote, append: async () => {}, save: async () => {}, finish });
  await loop.settled;
  expect(remote.detach).toHaveBeenCalledOnce(); expect(remote.cancel).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledOnce();
});

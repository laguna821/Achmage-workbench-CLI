import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { transform } from "esbuild";
import { expect, it } from "vitest";
import { patchOfficeExecution } from "../../../office/execution-patch.ts";
import { patchOfficeSkillConversation } from "../../../office/skill-conversation-patch.ts";

it("retains original Markdown send preparation and question branches in the actual pinned transform chain", async () => {
  const root = realpathSync(resolve("vendor/ieumoffice")), id = `${root}/apps/markdown/src/renderer/ai/AiPanel.tsx`;
  const patched = patchOfficeExecution(patchOfficeSkillConversation(readFileSync(id, "utf8"), id, root), id, root, "/adapter.ts");
  expect(patched).toContain("return send(instruction, undefined, state.scope)");
  expect(patched).toContain("askOfficeExecutionQuestion");
  await expect(transform(patched, { loader: "tsx", format: "esm" })).resolves.toHaveProperty("code");
});

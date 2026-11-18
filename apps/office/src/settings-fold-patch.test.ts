import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { foldOtherAiConnections } from "../settings-fold-patch.ts";

const source = readFileSync(resolve("vendor/ieumoffice/apps/shell/src/renderer/src/SettingsAiSection.tsx"), "utf8");

it("keeps only the Claude Code and Codex cards in view and folds every other AI connection, closed by default", () => {
  const out = foldOtherAiConnections(source);
  const fold = out.indexOf("고급 · 다른 AI 연결");
  expect(fold).toBeGreaterThan(0);
  expect(out).toContain("useState(openTab !== undefined)\n  const [wbOtherOpen, setWbOtherOpen] = useState(openTab !== undefined)");
  // Before the fold: the two cards (by filter) and the AI-use choice; after it, the rest, unchanged.
  const before = out.slice(0, fold), after = out.slice(fold);
  expect(before).toContain("provider === 'claude-code' || provider === 'codex'");
  expect(before).toContain('data-ai-use=""');
  expect(after).toContain("provider !== 'claude-code' && provider !== 'codex'");
  expect(after).toContain('id="set-free-ai"');
  expect(after).toContain("<FreeAiCards");
  expect(after).toContain("{advanced(tab, showCard)}");
  expect(after).toContain("{wbOtherOpen && (");
  // Nothing upstream offers is dropped: every card list, the free and local AI and the key panes remain.
  for (const part of ["<AiSubscriptionCard", "<LocalAiSection", "set-adv-toggle", "<ReadUrlTokenField"]) expect(out).toContain(part);
  expect(out.match(/ref=\{cardsRef\}/g)).toHaveLength(1);
});
it("fails loudly when the original section changes", () => {
  expect(() => foldOtherAiConnections(source.replace('id="set-free-ai"', 'id="set-free"'))).toThrow(/고급 · 다른 AI 연결/);
});

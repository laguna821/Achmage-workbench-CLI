import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { ChannelAuditRow } from "@workbench/contracts";
import { actionLabel } from "./PhoneMessenger.tsx";

// 설정 › 메신저 › 기록 never shows a raw action name (design review I9: "pairing.cancelled" was shown as is).
const row = (action: string): ChannelAuditRow => ({ id: 1, at: 1, bindingId: null, kind: "telegram", action, sessionId: null, requestId: null, target: null, result: null });

/** Every action the gateway writes to the record: the first quoted name in each `audit(…)` call of apps/host/src. */
function recordedActions() {
  const files = execSync("git ls-files apps/host/src", { encoding: "utf8" }).split("\n").filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const found = new Set<string>();
  for (const file of files) for (const match of readFileSync(file, "utf8").matchAll(/\baudit\((?:[^()"]|\([^()]*\))*?"([a-z_]+(?:\.[a-z_]+)*)"/g)) found.add(match[1]!);
  for (const kind of ["telegram", "slack"]) found.delete(kind); // a messenger's kind, not an action
  return [...found];
}

it("has words for every action the gateway records", () => {
  const actions = recordedActions();
  expect(actions.length).toBeGreaterThan(40);
  for (const action of actions) {
    const words = actionLabel(row(action));
    expect(words, action).not.toBe(action);
    expect(words, action).not.toMatch(/^[a-z_.]+$/);
  }
  expect(actionLabel(row("pairing.cancelled"))).toBe("연결 QR 거둠");
});

it("an action it does not know reads as a plain Korean word, never its code", () => {
  expect(actionLabel(row("something.new"))).toBe("그 밖의 기록");
});

it("draws no side stripes (I8): the risks, a request and a removal stand in the shell's notice form or under one hairline", () => {
  const css = readFileSync("apps/web/src/styles/phone-messenger.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).not.toMatch(/border-(left|inline-start)\s*:/);
});

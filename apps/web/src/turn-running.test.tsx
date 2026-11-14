import { describe, expect, it } from "vitest";
import type { Session, SessionStatus } from "@workbench/contracts";
import { turnRunning } from "./state.ts";

// The input's progress line (chat, document and web-pane composers) shows only while a turn runs.
const LINE: Record<SessionStatus, boolean> = {
  starting: true,
  running: true,
  awaitingApproval: false, // the approval capsule carries this state
  interrupting: false,
  idle: false, // finished
  error: false, // failed
};

describe("turnRunning", () => {
  for (const provider of ["claude", "codex"] as const) {
    for (const [status, shown] of Object.entries(LINE)) {
      it(`${provider} ${status}: ${shown ? "line" : "no line"}`, () => {
        expect(turnRunning({ provider, status } as Session)).toBe(shown);
      });
    }
  }
  it("no session, no line", () => {
    expect(turnRunning(undefined)).toBe(false);
    expect(turnRunning(null)).toBe(false);
  });
});

import { expect, it } from "vitest";
import type { SequencedEvent, Session } from "@workbench/contracts";
import { CompletionNotifications } from "./completion-notifications.ts";

const session = { id: "child", provider: "codex", purpose: "문서 AI", muted: false, archivedAt: null } as Session;
const event = (status = "completed", id = "end-1") => ({ type: "item.upserted", sessionId: "child", item: { kind: "turnEnd", id, status }, seq: 7, at: 10 }) as SequencedEvent;
it("announces a completed hidden document turn without requiring a rendered running status", () => {
  const notifications = new CompletionNotifications();
  expect(notifications.take(event(), session, "연구", true)).toMatchObject({ body: "연구 — 문서 AI", session });
  expect(notifications.take(event(), session, "연구", true)).toBeNull();
  expect(notifications.take(event("completed", "end-2"), session, "연구", true)).not.toBeNull();
});
it("does not call a stopped/failed turn a completed reply, or bypass notification preferences", () => {
  const notifications = new CompletionNotifications();
  for (const status of ["interrupted", "failed"]) expect(notifications.take(event(status), session, "연구", true)).toBeNull();
  expect(notifications.take(event("completed", "muted"), { ...session, muted: true }, "연구", true)).toBeNull();
  expect(notifications.take(event("completed", "disabled"), session, "연구", false)).toBeNull();
});

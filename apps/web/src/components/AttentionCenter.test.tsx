// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ATTENTION_LABEL, type AttentionEvent, type AttentionPayload, type AttentionTarget, type SequencedEvent, type Session, type Work } from "@workbench/contracts";
import { AttentionInbox, CompletionNotifications, watchAttentionPresence } from "../completion-notifications.ts";
import { initialState } from "../state.ts";
import { AttentionCenter } from "./AttentionCenter.tsx";
import { ConversationSheet } from "./docs/ConversationDrawer.tsx";

vi.mock("./Transcript.tsx", () => ({ Transcript: (props: { sessionId: string; focusItem?: { itemId: string; nonce: number } }) => <div data-testid="focused-transcript" data-session={props.sessionId} data-item={props.focusItem?.itemId} /> }));
vi.mock("./ImageGen.tsx", () => ({ ImageCard: () => null }));
vi.mock("./DocCards.tsx", () => ({ ProposalCard: () => null }));
vi.mock("./Diagram.tsx", () => ({ diagramComponents: () => ({}) }));

const event = (id = "attention-1", patch: Partial<AttentionEvent> = {}): AttentionEvent => ({ id, kind: "input_needed", taskRef: { hostId: "host-a", workspaceId: "space-a", sessionId: "child", nativeSessionId: "native", runId: "child/request-1", parentRunId: null, executorKind: "office" }, workId: "work", itemId: "approval-1", createdAt: 1000, readAt: null, resolvedAt: null, delivery: "sent", deliveryError: null, ...patch });
const session = { id: "child", hostId: "host-a", workId: "work", provider: "codex", purpose: "비공개 문서 AI", status: "awaitingApproval", muted: false, archivedAt: null, documentAgent: { artifactId: "document", parentSessionId: "main" } } as Session;
const state = { ...initialState, works: { work: { id: "work", title: "비공개 프로젝트" } as Work }, sessions: { child: session } };
const snapshot = (events: AttentionEvent[], seq = 10) => ({ hostId: "host-a", epoch: "epoch-a", seq, attention: { events, unread: events.filter(row => row.readAt === null).length } });
beforeEach(() => { vi.useFakeTimers(); HTMLDialogElement.prototype.showModal = function () { this.open = true; this.querySelector<HTMLButtonElement>("button")?.focus(); }; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(initial = [event()]) {
  let rows = initial;
  const attention = vi.fn(async () => ({ events: rows, unread: rows.filter(row => row.readAt === null).length }));
  const readAttention = vi.fn(async (id: string) => { const next = { ...rows.find(row => row.id === id)!, readAt: 2000 }; rows = rows.map(row => row.id === id ? next : row); return next; });
  const attentionTarget = vi.fn(async (id: string): Promise<AttentionTarget> => { const row = rows.find(row => row.id === id)!; return { hostId: "host-a", workId: row.workId, sessionId: row.taskRef.sessionId, itemId: row.itemId, artifactId: "document", taskRef: row.taskRef }; });
  const claimAttention = vi.fn(async (id: string, _clientId: string) => ({ claimed: true, payload: { title: "Achmage Workbench", body: ATTENTION_LABEL[rows.find(row => row.id === id)!.kind], attentionId: id } }));
  const attentionPresence = vi.fn(async (_presence: { clientId: string; sessionId: string | null; visible: boolean }, _keepalive = false) => ({ ok: true as const }));
  const inbox = new AttentionInbox({ attention, readAttention, attentionTarget, claimAttention, attentionPresence }); inbox.snapshot(snapshot(rows));
  return { inbox, attention, readAttention, attentionTarget, claimAttention, attentionPresence, setRows: (next: AttentionEvent[]) => { rows = next; } };
}

it("marks an alert read without approving it and restores overlay focus", async () => {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const f = fixture(), onOpen = vi.fn(async () => {}), onClose = vi.fn();
  const mounted = render(<AttentionCenter inbox={f.inbox} state={state} onOpen={onOpen} onClose={onClose} />);
  expect(screen.getByText("비공개 프로젝트 · 비공개 문서 AI")).toBeTruthy(); expect(screen.getByText("입력 필요")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "읽음 표시" })));
  expect(f.readAttention).toHaveBeenCalledWith("attention-1"); expect(onOpen).not.toHaveBeenCalled();
  expect(f.inbox.getState().list.unread).toBe(0); expect(state.sessions.child.status).toBe("awaitingApproval"); expect(f.inbox.getState().list.events[0]!.resolvedAt).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "읽지 않은 알림만" })); expect(screen.getByText("읽지 않은 알림이 없습니다.")).toBeTruthy();
  mounted.unmount(); expect(document.activeElement).toBe(opener); opener.remove();
});

it("resolves the exact document, child and item, and retains the panel on a foreign-host target", async () => {
  const f = fixture(), opened: AttentionTarget[] = [];
  const onOpen = async (id: string) => { opened.push(await f.inbox.target(id)); };
  render(<AttentionCenter inbox={f.inbox} state={state} onOpen={onOpen} onClose={() => {}} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "원문 열기" })));
  expect(opened).toEqual([{ hostId: "host-a", workId: "work", sessionId: "child", itemId: "approval-1", artifactId: "document", taskRef: event().taskRef }]);
  f.attentionTarget.mockResolvedValueOnce({ ...opened[0]!, hostId: "host-b" });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "원문 열기" })));
  expect(screen.getByRole("alert").textContent).toContain("호스트 또는 원문 대상이 달라졌습니다"); expect(opened).toHaveLength(1); expect(f.readAttention).not.toHaveBeenCalled();
});

it("keeps local read acknowledgements through delayed lists and snapshots and refreshes from the existing event stream", async () => {
  const f = fixture(); let finish!: (list: { events: AttentionEvent[]; unread: number }) => void;
  f.attention.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const reading = f.inbox.refresh(); await f.inbox.read("attention-1"); finish({ events: [event()], unread: 1 }); await reading;
  expect(f.inbox.getState().list.unread).toBe(0);
  f.inbox.snapshot(snapshot([event()], 9)); f.inbox.snapshot(snapshot([event()], 11));
  expect(f.inbox.getState().list.events[0]!.readAt).toBe(2000);
  const next = event("attention-2", { kind: "completed", itemId: "end-2", createdAt: 3000, resolvedAt: 3000 }); f.setRows([next, event()]);
  f.inbox.event({ type: "attention.changed", seq: 12, at: 3000 }); await f.inbox.refresh();
  expect(f.inbox.getState().list.events.map(row => row.id)).toEqual(["attention-2", "attention-1"]); expect(f.inbox.getState().list.unread).toBe(1);
  const old = new AttentionInbox(null); old.snapshot({ hostId: "old-host", seq: 1 });
  const legacy = new CompletionNotifications(), turn = { type: "item.upserted", sessionId: "child", item: { kind: "turnEnd", id: "done", status: "completed" }, seq: 2, at: 2 } as SequencedEvent;
  expect(legacy.take(turn, session, "비공개 프로젝트", old.getState().supported === false)).not.toBeNull();
  expect(new CompletionNotifications().take(turn, session, "비공개 프로젝트", f.inbox.getState().supported === false)).toBeNull();
});

it("claims only unavailable alerts once and sends generic payloads, keeping unknown delivery visible", async () => {
  const completed = event("complete", { kind: "completed", delivery: "unavailable", resolvedAt: 1000 });
  const resolved = event("resolved", { delivery: "unavailable", resolvedAt: 1100 });
  const f = fixture([completed, resolved, event("sent")]), deliver = vi.fn(async (_payload: AttentionPayload) => {});
  await Promise.all([f.inbox.fallback(deliver), f.inbox.fallback(deliver)]);
  expect(f.claimAttention).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledWith({ title: "Achmage Workbench", body: "작업이 완료되었습니다.", attentionId: "complete" });
  expect(JSON.stringify(deliver.mock.calls)).not.toContain("비공개");
  const unknown = event("unknown", { kind: "failed", delivery: "unavailable", resolvedAt: 1200 }); f.setRows([unknown]); f.inbox.snapshot(snapshot([unknown], 11));
  f.claimAttention.mockRejectedValueOnce(new TypeError("연결 끊김")); await f.inbox.fallback(deliver); await f.inbox.fallback(deliver);
  expect(f.claimAttention).toHaveBeenCalledTimes(2); expect(deliver).toHaveBeenCalledOnce(); expect(f.inbox.getState().error).toContain("전달을 확인하지 못했습니다");
});

it("reports active-session presence on focus/visibility changes, every 15 seconds, and false on leaving", async () => {
  const f = fixture(); let sessionId: string | null = "main", focused = true, hidden = false;
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused); vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const watcher = watchAttentionPresence(f.inbox, () => sessionId); await act(async () => {});
  expect(f.attentionPresence).toHaveBeenLastCalledWith({ clientId: f.inbox.clientId, sessionId: "main", visible: true }, false);
  sessionId = "child"; watcher.update(); await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(14999); }); expect(f.attentionPresence).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(f.attentionPresence).toHaveBeenCalledTimes(3);
  focused = false; fireEvent.blur(window); await act(async () => {}); expect(f.attentionPresence).toHaveBeenLastCalledWith({ clientId: f.inbox.clientId, sessionId: "child", visible: false }, false);
  focused = true; hidden = true; fireEvent(document, new Event("visibilitychange")); watcher.close(); await act(async () => {});
  expect(f.attentionPresence).toHaveBeenLastCalledWith({ clientId: f.inbox.clientId, sessionId: "child", visible: false }, true);
});

it("passes an exact original item into the document conversation overlay without answering approval", () => {
  const onAnswer = vi.fn(), onClose = vi.fn();
  render(<ConversationSheet state={state} session={session} focusItem={{ itemId: "approval-1", nonce: 7 }} onClose={onClose} onAnswer={onAnswer} />);
  expect(screen.getByTestId("focused-transcript").getAttribute("data-session")).toBe("child"); expect(screen.getByTestId("focused-transcript").getAttribute("data-item")).toBe("approval-1");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "대화 닫기" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" }); expect(onClose).toHaveBeenCalledOnce(); expect(onAnswer).not.toHaveBeenCalled();
});

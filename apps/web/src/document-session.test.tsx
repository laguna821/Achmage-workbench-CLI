// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DocumentRegistration, DocumentViewInput } from "@workbench/contracts";
import type { Api } from "./api.ts";
import { useDocumentSession } from "./document-session.ts";

afterEach(() => cleanup());
it("binds a changed conversation immediately and confirms the exact saved revision before AI starts", async () => {
  const registerDocument = vi.fn(async (artifactId: string, input: DocumentViewInput): Promise<DocumentRegistration> => ({ view: {
    artifactId, viewId: input.viewId, windowId: input.windowId, sessionId: input.sessionId ?? null,
    revision: input.revision ?? 1, dirty: input.dirty ?? false, label: "", mode: "write", expiresAt: Date.now() + 30000,
  }, writer: null, writeToken: "lease" }));
  const api = { registerDocument, closeDocument: vi.fn(async () => {}), forDocument: () => api } as unknown as Api;
  const { result, rerender } = renderHook(({ sessionId }) => useDocumentSession(api, "artifact", sessionId), { initialProps: { sessionId: "first" } });
  await waitFor(() => expect(result.current.registration?.view.sessionId).toBe("first"));
  rerender({ sessionId: "second" });
  await waitFor(() => expect(result.current.registration?.view.sessionId).toBe("second"));
  await act(async () => { await result.current.sync(false, 8); });
  expect(registerDocument).toHaveBeenLastCalledWith("artifact", expect.objectContaining({ sessionId: "second", dirty: false, revision: 8 }));
  registerDocument.mockRejectedValueOnce(new Error("connection lost"));
  await act(async () => { await expect(result.current.sync(false, 9)).rejects.toThrow("연결을 확인하지 못했습니다"); });
  expect(result.current.canWrite).toBe(false);
});

// A stand-in for the gateway's registry: one writer per document; a claim is granted only while
// there is none. `hold` keeps a request of one view in flight until released.
function registry() {
  const views = new Map<string, { windowId: string; mode: "read" | "write"; sessionId: string | null }>();
  const held = new Map<string, Promise<void>>();
  const presence = (artifactId: string, viewId: string) => ({ artifactId, viewId, windowId: views.get(viewId)!.windowId, sessionId: views.get(viewId)!.sessionId, revision: 1, dirty: false, label: "", mode: views.get(viewId)!.mode, expiresAt: Date.now() + 30000 });
  const writer = () => [...views.entries()].find(([, view]) => view.mode === "write")?.[0] ?? null;
  const registerDocument = vi.fn(async (artifactId: string, input: DocumentViewInput): Promise<DocumentRegistration> => {
    await held.get(input.viewId);
    if (!views.has(input.viewId)) views.set(input.viewId, { windowId: input.windowId, mode: "read", sessionId: input.sessionId ?? null });
    if (input.claim === true && !writer()) views.get(input.viewId)!.mode = "write";
    const current = writer();
    return { view: presence(artifactId, input.viewId), writer: current ? presence(artifactId, current) : null, writeToken: views.get(input.viewId)!.mode === "write" ? `lease-${input.viewId}` : null } as DocumentRegistration;
  });
  const closeDocument = vi.fn(async (viewId: string) => { await held.get(viewId); views.delete(viewId); });
  const api = { registerDocument, closeDocument, forDocument: () => api } as unknown as Api;
  return { api, registerDocument, closeDocument, views, hold: (viewId: string) => { let release!: () => void; held.set(viewId, new Promise<void>((done) => { release = done; })); return () => { held.delete(viewId); release(); }; } };
}

// Ruling: when a document view closes and another opens in the same window (a companion made a
// tab, a tab closed and the document opened again), the new view's claim can reach the gateway
// before the old view's close. It must not stay read-only for that.
it("a view opened while the same window's earlier view is still closing claims again once that one has released", async () => {
  const gateway = registry();
  const first = renderHook(() => useDocumentSession(gateway.api, "artifact", "ai"));
  await waitFor(() => expect(first.result.current.canWrite).toBe(true));
  // The old view's close is held behind a request of its own still in flight.
  const release = gateway.hold(first.result.current.viewId);
  first.unmount();
  const second = renderHook(() => useDocumentSession(gateway.api, "artifact", "ai"));
  await waitFor(() => expect(second.result.current.registration).not.toBeNull());
  // The claim arrived first: the gateway still names the old view as the writer.
  expect(second.result.current.canWrite).toBe(false);
  expect(second.result.current.registration?.writer?.viewId).toBe(first.result.current.viewId);
  release();
  await waitFor(() => expect(second.result.current.canWrite).toBe(true));
  expect(gateway.views.get(second.result.current.viewId)?.mode).toBe("write");
});

it("does not take the lease from a view that is still open (another tab or window edits the document)", async () => {
  const gateway = registry();
  const first = renderHook(() => useDocumentSession(gateway.api, "artifact", "ai"));
  await waitFor(() => expect(first.result.current.canWrite).toBe(true));
  const claims = () => gateway.registerDocument.mock.calls.filter(([, input]) => input.claim === true).length;
  const second = renderHook(() => useDocumentSession(gateway.api, "artifact", "ai"));
  await waitFor(() => expect(second.result.current.registration).not.toBeNull());
  await new Promise((done) => setTimeout(done, 30));
  expect(second.result.current.canWrite).toBe(false);
  expect(first.result.current.canWrite).toBe(true);
  // One claim each: the reader does not keep asking.
  expect(claims()).toBe(2);
});

it("a view that only reads (a document beside a conversation) never claims", async () => {
  const gateway = registry();
  const reader = renderHook(() => useDocumentSession(gateway.api, "artifact", "main", false));
  await waitFor(() => expect(reader.result.current.registration).not.toBeNull());
  expect(reader.result.current.canWrite).toBe(false);
  expect(gateway.registerDocument.mock.calls.every(([, input]) => input.claim !== true)).toBe(true);
});

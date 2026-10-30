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

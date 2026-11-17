// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Api } from "./api.ts";
import { useDocumentReferences } from "./document-references.ts";

const fakeApi = (isRemote: boolean) => ({
  isRemote,
  documentViews: vi.fn(async () => ({ views: [] })),
  resolveReferences: vi.fn(async () => { throw new Error("이 기기에 허용되지 않은 작업입니다."); }),
}) as unknown as Api & { documentViews: ReturnType<typeof vi.fn>; resolveReferences: ReturnType<typeof vi.fn> };

it("a line with no document references is sent without asking the gateway (a phone's send was refused here)", async () => {
  const api = fakeApi(true), onError = vi.fn();
  const { result } = renderHook(() => useDocumentReferences(api, "s", onError));
  let refs: unknown;
  await act(async () => { refs = await result.current.resolve([]); });
  expect(refs).toEqual([]);
  expect(api.resolveReferences).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it("a phone does not poll the PC's open-document views; the PC does", async () => {
  const remote = fakeApi(true);
  renderHook(() => useDocumentReferences(remote, "s", vi.fn()));
  const local = fakeApi(false);
  renderHook(() => useDocumentReferences(local, "s", vi.fn()));
  await act(async () => { await Promise.resolve(); });
  expect(remote.documentViews).not.toHaveBeenCalled();
  expect(local.documentViews).toHaveBeenCalled();
});

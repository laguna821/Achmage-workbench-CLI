// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import type { Api } from "./api.ts";
import { driveReopen } from "./App.tsx";

it("a phone opens a document itself and never asks the PC to reopen it in Drive (the channel refused that, and the document never opened)", async () => {
  const request = vi.fn(async () => ({ handled: true, ok: true }));
  expect(await driveReopen({ isRemote: true, request } as unknown as Api, "doc-1")).toEqual({ handled: false });
  expect(request).not.toHaveBeenCalled();
  expect(await driveReopen({ isRemote: false, request } as unknown as Api, "doc-1")).toEqual({ handled: true, ok: true });
  expect(request).toHaveBeenCalledWith("POST", "/api/office-drive/reopen", { artifactId: "doc-1" });
});

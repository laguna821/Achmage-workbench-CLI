// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkspaceService } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { WorkspaceServiceInspect } from "./WorkspaceServiceInspect.tsx";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("saves a service's response as plain bytes, also when the service answered with a web page", async () => {
  const handed: Blob[] = [], names: string[] = [];
  URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => { handed.push(blob as Blob); return "blob:saved"; });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
  const body = "<script>fetch('/steal?' + localStorage.length)</script>";
  const api = { workspaceServiceProxy: vi.fn(async () => new Response(body, { headers: { "content-type": "text/html" } })) } as unknown as Api;
  const service = { id: "service-0123456789abcdef", label: "개발 서버", hostId: "desk", port: 5173 } as unknown as WorkspaceService;
  render(<WorkspaceServiceInspect api={api} service={service} mode="proxy" onClose={() => {}} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "요청 보내기" })));
  await act(async () => fireEvent.click(await screen.findByRole("button", { name: "응답 파일 저장" })));
  expect(handed.map(blob => blob.type)).toEqual(["application/octet-stream"]);
  expect(await handed[0]!.text()).toBe(body);
  expect(names).toEqual(["service-service-0123-response"]);
});

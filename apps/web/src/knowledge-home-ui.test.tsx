// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeHome } from "./components/KnowledgeHome.tsx";
import type { Api } from "./api.ts";
import type { State } from "./state.ts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("accepts only the exact home frame and keeps its calls/frame alive while hidden, then closes only that owner", async () => {
  const origin = "http://127.0.0.1:54321", pending: AbortSignal[] = [];
  const request = vi.fn(async (method: string, path: string, _body?: unknown, options?: { signal?: AbortSignal }) => {
    if (path.endsWith("/page")) return { origin, url: origin + "/office/knowledge.html" };
    if (path.endsWith("/home") && method === "POST") return { owner: "home-owner" };
    if (method === "DELETE") return { ok: true };
    if (options?.signal) pending.push(options.signal);
    return new Promise(() => {});
  });
  const api = { request } as unknown as Api, state = { works: {}, workspaces: {} } as State;
  const props = { api, state, visible: true, theme: "light" as const, refreshToken: 0, onOpen: vi.fn(), onManage: vi.fn(), onSettings: vi.fn(), onSkills: vi.fn() };
  const { container, rerender, unmount } = render(<KnowledgeHome {...props} />);
  await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  const frame = container.querySelector("iframe")!, win = frame.contentWindow!;
  expect(frame.src).not.toMatch(/token|authorization|home-owner/);
  const data = { type: "knowledge:request", requestId: "request", channel: "home:skills", args: [{ operation: "list" }] };
  window.dispatchEvent(new MessageEvent("message", { origin, source: window, data }));
  window.dispatchEvent(new MessageEvent("message", { origin: "http://other.invalid", source: win, data }));
  window.dispatchEvent(new MessageEvent("message", { origin, source: win, data: { ...data, channel: "document:write" } }));
  expect(request).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new MessageEvent("message", { origin, source: win, data }));
  await waitFor(() => expect(pending).toHaveLength(1));
  rerender(<KnowledgeHome {...props} visible={false} />);
  expect(container.querySelector("iframe")).toBe(frame); expect(pending[0]?.aborted).toBe(false);
  rerender(<KnowledgeHome {...props} />);
  expect(container.querySelector("iframe")?.contentWindow).toBe(win);
  expect(request).toHaveBeenCalledTimes(3);
  unmount(); expect(pending[0]?.aborted).toBe(true);
  expect(request).toHaveBeenLastCalledWith("DELETE", "/api/office-knowledge/home/home-owner", undefined, { keepalive: true });
});
it("passes the selected workspace to creation and opens only a successful template result", async () => {
  const origin = "http://127.0.0.1:54321", onOpen = vi.fn();
  const request = vi.fn(async (_method: string, path: string) => {
    if (path.endsWith("/page")) return { origin, url: origin + "/office/knowledge.html" };
    if (path.endsWith("/home")) return { owner: "owner" };
    return { ok: true, tabId: "created-document", artifact: { id: "created-document", workId: "project" } };
  });
  const state = { works: { project: { id: "project", title: "Project", defaultWorkspaceId: "workspace" } }, workspaces: { workspace: { id: "workspace", workId: "project", label: "main" } } } as unknown as State;
  const { container } = render(<KnowledgeHome api={{ request } as unknown as Api} state={state} workId="project" theme="light" visible refreshToken={0} onOpen={onOpen} onManage={() => {}} onSettings={() => {}} onSkills={() => {}} />);
  await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  const input = { operation: "open-template", input: { requestId: "once", skillId: "selected", text: "Create", chips: [] } };
  window.dispatchEvent(new MessageEvent("message", { origin, source: container.querySelector("iframe")!.contentWindow, data: { type: "knowledge:request", requestId: "rpc", channel: "home:skills", args: [input] } }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith({ id: "created-document", workId: "project" }));
  expect(request).toHaveBeenLastCalledWith("POST", "/api/office-knowledge/home/owner/invoke", { channel: "home:skills", args: [input], destination: { workId: "project", workspaceId: "workspace" } }, { signal: expect.any(AbortSignal) });
});

// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OfficeSettings } from "./components/OfficeSettings.tsx";
import type { Api } from "./api.ts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it.each(["ai:custom-models", "ai:subscription-install"])("grants %s RPC to only the exact settings frame and cancels its requests on close", async (channel) => {
  const listener = vi.spyOn(window, "addEventListener");
  const origin = "http://127.0.0.1:54321", started: AbortSignal[] = [];
  const request = vi.fn(async (_method: string, path: string, _body?: unknown, options?: { signal?: AbortSignal }) => {
    if (path.endsWith("/page")) return { origin, url: `${origin}/office/settings.html` };
    if (options?.signal) started.push(options.signal);
    return new Promise(() => {});
  });
  const { container, unmount } = render(<OfficeSettings api={{ request } as unknown as Api} theme="light" onClose={() => {}} />);
  await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  await waitFor(() => expect(listener.mock.calls.some(([type]) => type === "message")).toBe(true));
  const frame = container.querySelector("iframe")!, win = frame.contentWindow!;
  expect(frame.src).not.toMatch(/token|authorization/);
  const message = { type: "office-settings:request", requestId: "fixture-id", channel, args: [{ provider: "codex", baseUrl: "http://localhost:1234" }] };
  window.dispatchEvent(new MessageEvent("message", { origin, source: window, data: message }));
  window.dispatchEvent(new MessageEvent("message", { origin: "http://wrong.invalid", source: win, data: message }));
  window.dispatchEvent(new MessageEvent("message", { origin, source: win, data: { ...message, channel: "document:write" } }));
  expect(request).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new MessageEvent("message", { origin, source: win, data: message }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(request.mock.calls[1]).toMatchObject(["POST", "/api/office-ai/invoke", { channel: message.channel, args: message.args, owner: expect.any(String) }, { signal: expect.any(AbortSignal) }]);
  expect(started[0]?.aborted).toBe(false);
  unmount(); expect(started[0]?.aborted).toBe(true);
});

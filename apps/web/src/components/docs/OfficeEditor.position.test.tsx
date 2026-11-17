// @vitest-environment jsdom
// A woken document comes back where it was (office-leftovers point 3): the page says where its view is, the tab keeps
// it, and a page opened again (the tab woke, or the editor was reopened) is told in its init.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact, OfficeViewPosition } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import { OfficeEditor } from "./OfficeEditor.tsx";

afterEach(() => { cleanup(); });

it("passes the kept place in the init of a page opened again, and hands every new place to the tab", async () => {
  const api = { editorGrant: async () => ({ token: "test", sessionId: "session", origin: "http://office.test", url: "http://office.test/slides" }) } as unknown as Api;
  const artifact = { id: "doc", name: "deck.pptx", format: "pptx", revision: 1, path: "/deck.pptx", sha256: "x" } as Artifact;
  const kept: OfficeViewPosition = { slide: 4, scroll: { top: 120, left: 0, fraction: 0.4 } };
  const told: OfficeViewPosition[] = [];
  const screen = render(<OfficeEditor sessionId="session" api={api} artifact={artifact} onStatus={() => {}} onNotice={() => {}} onPrepareAi={async () => {}} onNewSession={async () => "session"} onAiSettings={() => {}}
    viewPosition={kept} onViewPosition={(position) => told.push(position)} />);
  await act(async () => {});
  const frame = screen.container.querySelector("iframe")!;
  const sent = vi.spyOn(frame.contentWindow!, "postMessage");
  const message = async (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: "http://office.test", source: frame.contentWindow, data })); });
  await message({ type: "office:ready" });
  const init = sent.mock.calls.map(([data]) => data as { type: string; view?: OfficeViewPosition }).find((data) => data.type === "office:init");
  expect(init?.view).toEqual(kept);
  await message({ type: "office:view-position", position: { slide: 6 } });
  expect(told).toEqual([{ slide: 6 }]);
});

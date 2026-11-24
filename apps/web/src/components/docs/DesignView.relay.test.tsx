// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Artifact } from "@workbench/contracts";
import { DesignView } from "./DesignView.tsx";

// A phone joined to the PC (0.5.6): the design page has no /api/ of its own there, so it reads its own
// document through the window (design:fetch → design:fetched), read only; nothing else is relayed.

afterEach(cleanup);
const artifact = { id: "design-1", name: "카드뉴스.design.json", revision: 3 } as Artifact;
const noop = () => undefined;

async function mount(relay?: (path: string) => Promise<{ status: number; contentType: string; body: ArrayBuffer }>) {
  const view = render(<DesignView artifact={artifact} relay={relay} onStatus={noop} onSelection={noop} onCopied={noop} onExported={noop} onError={noop} />);
  const frame = view.container.querySelector("iframe")!;
  const sent: unknown[] = [];
  vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => { sent.push(message); });
  const say = (data: unknown) => act(async () => { window.dispatchEvent(new MessageEvent("message", { data, origin: location.origin, source: frame.contentWindow })); await Promise.resolve(); await Promise.resolve(); });
  return { sent, say };
}

it("on a phone: the page is told to read through the window, read only, with no token", async () => {
  const { sent, say } = await mount(async () => ({ status: 200, contentType: "application/json", body: new ArrayBuffer(2) }));
  await say({ type: "design:ready" });
  expect(sent[0]).toMatchObject({ type: "design:init", artifactId: "design-1", readOnly: true, relay: true, token: "" });
});

it("relays this design's own text and pictures, and refuses any other path", async () => {
  const body = new TextEncoder().encode('{"text":"{}"}').buffer as ArrayBuffer;
  const relay = vi.fn(async () => ({ status: 200, contentType: "application/json", body }));
  const { sent, say } = await mount(relay);
  await say({ type: "design:fetch", id: "r1", path: "/api/artifacts/design-1/text?revision=3" });
  await say({ type: "design:fetch", id: "r2", path: "/api/artifacts/design-1/asset?src=a.png" });
  await say({ type: "design:fetch", id: "r3", path: "/api/artifacts/other/text" });
  await say({ type: "design:fetch", id: "r4", path: "/api/devices" });
  expect(relay.mock.calls.map((call) => (call as unknown[])[0])).toEqual(["/api/artifacts/design-1/text?revision=3", "/api/artifacts/design-1/asset?src=a.png"]);
  expect(sent).toContainEqual(expect.objectContaining({ type: "design:fetched", id: "r1", status: 200, body }));
  expect(sent).toContainEqual(expect.objectContaining({ type: "design:fetched", id: "r3", status: 403, body: null }));
  expect(sent).toContainEqual(expect.objectContaining({ type: "design:fetched", id: "r4", status: 403, body: null }));
});

it("on the PC nothing is relayed: the page reads with its token as before", async () => {
  const { sent, say } = await mount(undefined);
  await say({ type: "design:ready" });
  expect(sent[0]).toMatchObject({ type: "design:init", readOnly: false });
  expect((sent[0] as { relay?: boolean }).relay).toBeUndefined();
  await say({ type: "design:fetch", id: "r1", path: "/api/artifacts/design-1/text" });
  expect(sent).toContainEqual(expect.objectContaining({ type: "design:fetched", id: "r1", status: 403 }));
});

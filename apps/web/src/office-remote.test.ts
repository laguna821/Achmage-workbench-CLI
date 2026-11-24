import { afterEach, expect, it, vi } from "vitest";
import { setMediaConnection } from "./api.ts";
import { officePages } from "./office.ts";

// A phone joined to the PC (0.5.6): Word/PowerPoint page pictures are asked over the device channel; the
// phone page's own origin answers no /api/ (it said "보호된 기기 연결이 필요합니다" and the 쪽 보기 stayed empty).

afterEach(() => { setMediaConnection(null); vi.unstubAllGlobals(); });

it("asks the PC over the device channel when the page is a phone joined to it", async () => {
  const direct = vi.fn(async () => Response.json({ code: "protected_channel_required" }, { status: 404 }));
  vi.stubGlobal("fetch", direct);
  const peer = { fetch: vi.fn(async () => Response.json({ pages: [{ page: 1, width: 600, height: 800 }] })) };
  setMediaConnection({ hostId: "pc", peer: peer as never });
  expect(await officePages({ artifactId: "doc-remote", revision: 2 })).toEqual([{ page: 1, width: 600, height: 800 }]);
  expect(peer.fetch).toHaveBeenCalledWith("/api/artifacts/doc-remote/office-pages?revision=2");
  expect(direct).not.toHaveBeenCalled();
});

it("on the PC: its own gateway with the token, as before", async () => {
  const direct = vi.fn(async () => Response.json({ pages: [] }));
  vi.stubGlobal("fetch", direct);
  await officePages({ artifactId: "doc-local", revision: 1 });
  expect(direct).toHaveBeenCalledWith("/api/artifacts/doc-local/office-pages?revision=1", expect.objectContaining({ headers: expect.objectContaining({ authorization: expect.stringMatching(/^Bearer /) }) }));
});

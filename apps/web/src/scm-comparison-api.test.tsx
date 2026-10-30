import { afterEach, expect, it, vi } from "vitest";
import type { ScmComparisonPreferences } from "@workbench/contracts";
import { Api } from "./api.ts";

afterEach(() => vi.unstubAllGlobals());
const form: ScmComparisonPreferences = { mode: "combined", base: "HEAD", head: "HEAD", merge: true, parent: 1, wrap: false };
it("waits for preceding workspace preference writes before a reopened view reads them", async () => {
  const requests: { method: string; body: ScmComparisonPreferences; reply: (response: Response) => void }[] = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>((reply) => requests.push({ method: options.method!, body: options.body ? JSON.parse(String(options.body)) : null, reply }))));
  const api = new Api("test"), first = api.saveScmComparisonPreferences("space", form), last = api.saveScmComparisonPreferences("space", { ...form, wrap: true }), reopened = api.scmComparisonPreferences("space");
  await vi.waitFor(() => expect(requests).toHaveLength(1)); expect(requests[0]!.method).toBe("PUT");
  requests[0]!.reply(Response.json({ preferences: requests[0]!.body })); await first;
  await vi.waitFor(() => expect(requests).toHaveLength(2)); expect(requests[1]!.method).toBe("PUT"); expect(requests[1]!.body.wrap).toBe(true);
  requests[1]!.reply(Response.json({ preferences: requests[1]!.body })); await last;
  await vi.waitFor(() => expect(requests).toHaveLength(3)); expect(requests[2]!.method).toBe("GET");
  requests[2]!.reply(Response.json({ preferences: requests[1]!.body })); expect((await reopened)?.wrap).toBe(true);
});
it("does not block another workspace or poison later saves after a failed preference request", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit) => url.includes("/bad/") && JSON.parse(String(options.body)).wrap === false ? Response.json({ code: "disk_full", message: "저장 실패" }, { status: 507 }) : Response.json({ preferences: JSON.parse(String(options.body)) })));
  const api = new Api("test");
  const failed = api.saveScmComparisonPreferences("bad", form); await expect(failed).rejects.toMatchObject({ code: "disk_full" });
  const other = await api.saveScmComparisonPreferences("other", form); expect(other.wrap).toBe(false);
  expect((await api.saveScmComparisonPreferences("bad", { ...form, wrap: true })).wrap).toBe(true);
});

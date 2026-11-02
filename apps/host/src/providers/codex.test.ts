import { describe, expect, it, vi } from "vitest";
import type { ModelListResponse } from "@workbench/provider-codex/src/generated/v2/ModelListResponse.ts";
import { CodexAdapter, currentModels, modelsFromList, turnSettings } from "./codex.ts";
import type { CodexRpc } from "@workbench/provider-codex/src/rpc.ts";
import type { AdapterSink } from "./types.ts";

const model = (id: string, isDefault: boolean, defaultEffort: string) =>
  ({
    id,
    model: id,
    displayName: id,
    description: "",
    hidden: false,
    isDefault,
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: "" })),
  }) as unknown as ModelListResponse["data"][number];

const list = { data: [model("sol", true, "low"), model("luna", false, "medium")], nextCursor: null } as unknown as ModelListResponse;

describe("Codex model settings", () => {
  it("treats the config.toml model and effort as the default", () => {
    const options = modelsFromList(list, { model: "luna", effort: "high" });
    expect(options.find((option) => option.isDefault)).toMatchObject({ id: "luna", defaultEffort: "high" });
    expect(options.find((option) => option.id === "sol")?.isDefault).toBe(false);
  });

  it("names model and effort on every turn so going back to default really resets", () => {
    const options = modelsFromList(list, { model: "sol", effort: "medium" });
    expect(turnSettings({ model: null, effort: null }, options)).toEqual({ model: "sol", effort: "medium" });
    expect(turnSettings({ model: "luna", effort: null }, options)).toEqual({ model: "luna", effort: "medium" });
    expect(turnSettings({ model: "luna", effort: "high" }, options)).toEqual({ model: "luna", effort: "high" });
    expect(turnSettings({ model: "unknown", effort: null }, options)).toEqual({ model: "unknown", effort: null });
  });
});

it("reads every engine model page without hard-coded model names", async () => {
  const request = vi.fn().mockResolvedValueOnce({ data: [model("new-sol", true, "medium")], nextCursor: "page2" })
    .mockResolvedValueOnce({ data: [model("future-terra", false, "high")], nextCursor: null });
  const result = await currentModels({ request } as unknown as Pick<CodexRpc, "request">);
  expect(result.data.map(entry => entry.model)).toEqual(["new-sol", "future-terra"]);
  expect(request).toHaveBeenLastCalledWith("model/list", { limit: 100, includeHidden: false, cursor: "page2" });
});

it("refreshes an already populated model picker despite an unavailable usage endpoint", async () => {
  let catalog = list, account = "first@example.com";
  const request = vi.fn(async (method: string) => {
    if (method === "account/read") return { account: { type: "chatgpt", email: account, planType: "pro" } };
    if (method === "config/read") return { config: {} };
    if (method === "model/list") return catalog;
    throw Error("Usage endpoint temporarily unavailable");
  });
  const adapter = new CodexAdapter({ providerStatus: vi.fn() } as unknown as AdapterSink);
  Object.assign(adapter, { rpc: { running: true, request } });
  expect((await adapter.refreshStatus()).models.map(entry => entry.id)).toEqual(["sol", "luna"]);
  catalog = { data: [model("newly-released", true, "high")], nextCursor: null } as ModelListResponse;
  expect((await adapter.refreshStatus()).models.map(entry => entry.id)).toEqual(["newly-released"]);
  account = "other@example.com";
  catalog = { data: [], nextCursor: null } as ModelListResponse;
  expect((await adapter.refreshStatus()).models).toEqual([]);
});

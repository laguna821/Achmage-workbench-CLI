import { describe, expect, it } from "vitest";
import type { ModelListResponse } from "@workbench/provider-codex/src/generated/v2/ModelListResponse.ts";
import { modelsFromList, turnSettings } from "./codex.ts";

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

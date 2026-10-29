import { describe, expect, it } from "vitest";
import { modelsFromInfo } from "./providers/claude.ts";
import { MODEL_CACHE_TTL, modelCacheKey, readModelCache } from "./providers/model-cache.ts";

describe("Claude engine model identities", () => {
  it("preserves the requested alias and its resolved model without selecting two defaults", () => {
    const options = modelsFromInfo([
      { value: "large", displayName: "Large", description: "", resolvedModel: "wire-large", supportedEffortLevels: ["high", "max"] },
      { value: "default", displayName: "Engine default", description: "", resolvedModel: "wire-default" },
    ]);
    expect(options[0]).toMatchObject({ id: "large", resolvedModel: "wire-large", isDefault: false, efforts: ["high", "max"] });
    expect(options.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["default"]);
  });
  it("invalidates cached models after an account or engine change, expiry, or malformed data", () => {
    const models = modelsFromInfo([{ value: "default", displayName: "Default", description: "" }]);
    const key = modelCacheKey(["engine-v1", "account-a"]);
    const cache = { key, at: 100, models };
    expect(readModelCache(cache, key, 200)).toEqual(models);
    expect(readModelCache(cache, modelCacheKey(["engine-v2", "account-a"]), 200)).toBeNull();
    expect(readModelCache(cache, modelCacheKey(["engine-v1", "account-b"]), 200)).toBeNull();
    expect(readModelCache(cache, key, 100 + MODEL_CACHE_TTL)).toBeNull();
    expect(readModelCache({ at: 100, models }, key, 200)).toBeNull();
    expect(readModelCache({ ...cache, models: [null] }, key, 200)).toBeNull();
  });
});

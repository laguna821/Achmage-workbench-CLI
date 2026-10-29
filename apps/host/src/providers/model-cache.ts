import { createHash } from "node:crypto";
import type { ModelOption } from "@workbench/contracts";

export const MODEL_CACHE_TTL = 24 * 60 * 60_000;

/** Account identity stays hashed in the on-disk cache. Old, unscoped caches are ignored. */
export function modelCacheKey(identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function readModelCache(raw: unknown, key: string, now = Date.now()): ModelOption[] | null {
  if (!raw || typeof raw !== "object") return null;
  const cache = raw as { key?: unknown; at?: unknown; models?: unknown };
  if (cache.key !== key || typeof cache.at !== "number" || cache.at > now || now - cache.at >= MODEL_CACHE_TTL) return null;
  if (!Array.isArray(cache.models) || !cache.models.length) return null;
  if (!cache.models.every((model: Partial<ModelOption> | null) => model && typeof model.id === "string" && typeof model.label === "string" && Array.isArray(model.efforts) && model.efforts.every((effort) => typeof effort === "string") && typeof model.isDefault === "boolean")) return null;
  return cache.models as ModelOption[];
}

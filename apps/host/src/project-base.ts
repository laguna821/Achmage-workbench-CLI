import { parseDocument } from "yaml";
import type { BaseValue } from "@workbench/contracts";
import { splitFrontmatter } from "./frontmatter.ts";

/** Typed, read-only values for Bases comparisons. The original Markdown is never serialized back. */
export function baseProperties(markdown: string): Record<string, BaseValue> | null {
  const yaml = splitFrontmatter(markdown).yaml;
  if (yaml === null) return /^﻿?---\s*\r?\n/.test(markdown) ? null : {};
  if (yaml.length > 256_000) return null;
  try {
    const document = parseDocument(yaml, { uniqueKeys: true, logLevel: "silent" });
    if (document.errors.length || document.warnings.length) return null;
    const raw: unknown = document.toJS({ maxAliasCount: 0 });
    if (raw === null) return {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = (input: unknown, depth = 0): BaseValue => {
      if (depth > 8) return null;
      if (typeof input === "string" || typeof input === "boolean" || input === null) return input;
      if (typeof input === "number") return Number.isFinite(input) ? input : null;
      if (Array.isArray(input)) return input.slice(0, 1000).map((item) => value(item, depth + 1));
      return null;
    };
    return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, value(item)]));
  } catch { return null; }
}

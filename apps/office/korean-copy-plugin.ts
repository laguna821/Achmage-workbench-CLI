import type { Plugin } from "vite";
import { KOREAN_COPY } from "./src/korean-copy.ts";

const norm = (path: string) => path.split("?")[0]!.replaceAll("\\", "/");

/** The Korean copy for one vendored module, or null when it has none. Throws when a text is gone. */
export function applyKoreanCopy(id: string, code: string): string | null {
  const file = norm(id);
  const entries = KOREAN_COPY.filter((entry) => file.endsWith(`/vendor/ieumoffice/${entry.file}`));
  if (!entries.length) return null;
  let next = code;
  for (const entry of entries) {
    if (next.split(entry.from).length - 1 !== 1) throw new Error(`Korean copy: the vendored text changed in ${entry.file} (${entry.from.slice(0, 60)}); review apps/office/src/korean-copy.ts`);
    next = next.replace(entry.from, () => entry.to);
  }
  return next;
}

/** Build-time plugin: applies KOREAN_COPY; the build fails if an entry never found its file. */
export function koreanCopy(): Plugin {
  const applied = new Set<string>();
  return {
    name: "workbench-korean-copy",
    enforce: "pre",
    transform(code, id) {
      let next: string | null;
      try { next = applyKoreanCopy(id, code); } catch (error) { this.error((error as Error).message); }
      if (next === null) return null;
      for (const entry of KOREAN_COPY) if (norm(id).endsWith(`/vendor/ieumoffice/${entry.file}`)) applied.add(entry.file);
      return { code: next, map: null };
    },
    buildEnd(error) {
      if (error) return;
      const missing = [...new Set(KOREAN_COPY.map((entry) => entry.file))].filter((file) => !applied.has(file));
      if (missing.length) this.error(`Korean copy never applied (file not loaded): ${missing.join(", ")}`);
    },
  };
}

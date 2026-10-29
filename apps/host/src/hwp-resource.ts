import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import engine from "../../../vendor/ieumoffice/vendor/rhwp-core/package.json" with { type: "json" };
import { repoRoot, shipped } from "./resources.ts";

/** The host and studio use the same pinned engine bytes; packaged builds have one WASM copy. */
export function hwpWasmPath(): string {
  const root = repoRoot();
  const manifest = shipped("web/office/studio/build.json");
  let path: string | null = null;
  if (manifest) {
    const build = JSON.parse(readFileSync(manifest, "utf8"));
    if (build.schemaVersion !== 1 || build.wasmSha256 !== engine.rhwp.wasmSha256 || typeof build.wasm !== "string" || !/^assets\/[\w.-]+\.wasm$/.test(build.wasm)) throw new Error("한글 편집기 빌드 정보가 맞지 않습니다.");
    path = join(dirname(manifest), build.wasm);
  } else if (root) path = join(root, "vendor/ieumoffice/vendor/rhwp-core/rhwp_bg.wasm");
  if (!path || !existsSync(path)) throw new Error("한글 편집기 엔진이 빌드되지 않았습니다.");
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== engine.rhwp.wasmSha256) throw new Error("한글 편집기 엔진의 해시가 맞지 않습니다.");
  return path;
}

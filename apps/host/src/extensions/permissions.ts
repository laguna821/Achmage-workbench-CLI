import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionCall, ExtensionGrant, ExtensionPermission } from "@workbench/contracts";
import { HttpError } from "../errors.ts";

export function authorizeExtensionCall(call: ExtensionCall, grant: ExtensionGrant): boolean {
  return grant.enabled && grant.revokedAt === null && grant.extensionId === call.extensionId
    && grant.artifactHash === call.artifactHash && grant.generation === call.grantGeneration
    && grant.capabilities.includes(call.capability) && grant.workspaceIds.includes(call.workspaceId);
}
export function requireExtensionCall(call: ExtensionCall, grant: ExtensionGrant): void {
  if (!authorizeExtensionCall(call, grant)) throw new HttpError(403, "extension_grant_denied", "확장의 현재 권한 또는 프로젝트 범위가 맞지 않습니다.");
}
export function normalizePermissions(value: ExtensionPermission): ExtensionPermission {
  if (!value || !Array.isArray(value.files) || !Array.isArray(value.network)
    || value.files.some(v => v !== "read" && v !== "write") || value.network.length > 20) {
    throw new HttpError(400, "extension_permissions", "확장 권한 형식이 잘못되었습니다.");
  }
  const network = value.network.map(raw => {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search
      || url.hostname === "localhost" || url.hostname.includes(":") || /^\d+(\.\d+){3}$/.test(url.hostname)) {
      throw new HttpError(400, "extension_endpoint", "네트워크 권한에는 인증 정보 없는 HTTPS 도메인과 경로를 지정해야 합니다.");
    }
    return url.href;
  });
  return { files: [...new Set(value.files)], network: [...new Set(network)] };
}
export function permissionsSubset(actual: ExtensionPermission, requested: ExtensionPermission): boolean {
  return actual.files.every(v => requested.files.includes(v)) && actual.network.every(v => requested.network.includes(v));
}
/** Denies absolute paths, parent traversal and every symlink component. */
export function scopedFile(root: string, relative: string, create = false): string {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || /[\\:]/.test(relative)
    || path.isAbsolute(relative) || relative.split("/").some(v => v === ".." || v === "." || !v)) {
    throw new HttpError(403, "extension_path_denied", "프로젝트 안의 상대 파일 경로만 사용할 수 있습니다.");
  }
  const realRoot = realpathSync(root);
  const segments = relative.split("/");
  let current = realRoot;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    let info;
    try { info = lstatSync(current); } catch (error) {
      if (create && index === segments.length - 1 && (error as NodeJS.ErrnoException).code === "ENOENT") return current;
      throw error;
    }
    if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) {
      throw new HttpError(403, "extension_path_denied", "심볼릭 링크 경로는 확장에서 사용할 수 없습니다.");
    }
  }
  const real = realpathSync(current);
  if (path.relative(realRoot, real).split(path.sep).includes("..") || real === realRoot) {
    throw new HttpError(403, "extension_path_denied", "프로젝트 밖의 파일입니다.");
  }
  return real;
}

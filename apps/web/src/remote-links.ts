// A file link in a conversation's answer, opened on a phone joined to the PC (0.5.6): the phone's page has no file of
// the PC behind a path, so the link becomes the document it names — tracked already, or a file inside one of the
// phone's projects — or one plain line saying why it does not open.

/** The local path a link names (an absolute path, file://, a drive path), or null for a web link, an anchor or a bare name. */
export function localPathOf(href: string): string | null {
  let value = href.trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\//i, "");
  else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[A-Za-z]:[\\/]/.test(value)) return null;
  if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return null;
  value = value.replace(/#.*$/, "");
  try { value = decodeURIComponent(value); } catch { /* kept as written */ }
  return value || null;
}

export type Folder = { workId: string; workspaceId?: string; cwd: string };

/** The deepest folder holding `path`, and the path inside it; null when none holds it. */
export function folderOf(path: string, folders: Folder[]): { workId: string; workspaceId: string | undefined; relative: string } | null {
  const inside = (cwd: string) => { const root = cwd.replace(/[\\/]+$/, ""); return path.startsWith(root + "/") || path.startsWith(root + "\\") ? path.slice(root.length + 1) : null; };
  let best: { folder: Folder; relative: string } | null = null;
  for (const folder of folders) {
    const relative = inside(folder.cwd);
    if (relative !== null && (!best || folder.cwd.length > best.folder.cwd.length)) best = { folder, relative };
  }
  return best ? { workId: best.folder.workId, workspaceId: best.folder.workspaceId, relative: best.relative } : null;
}

/** The vault (볼트, 자료) stays the PC's: a phone's rail has no 볼트. */
export const REMOTE_RAIL_OMIT = ["vault"] as const;

/** Said on the phone, in place of a bare "권한 없음". */
/** The reason first: a phone's top line shows its first words. */
export const OUTSIDE_PHONE_PROJECTS = "휴대폰에 허용하지 않은 프로젝트의 문서라 열 수 없습니다. PC에서 열거나, PC의 설정 › 휴대폰과 다른 기기에서 그 프로젝트를 허용하세요.";
export const FILE_OUTSIDE_PROJECTS = "허용한 프로젝트 폴더 밖의 파일이라 휴대폰에서 열 수 없습니다. PC에서 여세요.";

/** 불러오기 from a phone: one file at most this size (the gateway's REMOTE_UPLOAD_LIMIT). */
export const PHONE_UPLOAD_LIMIT = 25 * 1024 * 1024;
/** The files a phone sends, and one line for those left out (over the limit). */
export function phoneUploads<T extends { name: string; size: number }>(files: T[]): { send: T[]; line: string | null } {
  const big = files.filter((file) => file.size > PHONE_UPLOAD_LIMIT);
  return { send: files.filter((file) => file.size <= PHONE_UPLOAD_LIMIT), line: big.length ? `25MB가 넘는 파일은 휴대폰에서 불러오지 않습니다(${big.map((file) => file.name).join(", ")}). PC에서 불러오세요.` : null };
}

import type { ScmDiff, ScmFile, ScmHunk, ScmHunkSelection } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { scmHash, scmPath } from "./scm-status.ts";

export const hunkAction = (action: string) => action === "stage-hunks" || action === "unstage-hunks";
export function validateHunkSelection(value: ScmHunkSelection | undefined): ScmHunkSelection {
  if (!value || typeof value.path !== "string" || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision) || !Array.isArray(value.hunks) || !value.hunks.length || value.hunks.length > 2000 || value.hunks.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new HttpError(400, "scm_hunks", "검토한 변경 구간을 선택하세요.");
  return { path: scmPath(value.path), expectedRevision: value.expectedRevision, hunks: [...new Set(value.hunks)].sort() };
}

/** IDs refer only to complete, server-produced Git hunks, never a caller's patch text. */
export function describeHunks(diff: ScmDiff, file: ScmFile, validUtf8: boolean): Pick<ScmDiff, "hunks" | "partialReason"> {
  const whole = (reason: string) => ({ hunks: [], partialReason: reason });
  if (file.conflicted) return whole("충돌 파일은 3방향 검토에서 해결하세요.");
  if (diff.truncated) return whole("일부만 표시된 변경은 구간별로 스테이징할 수 없습니다. 전체 파일을 검토하세요.");
  if (diff.binary || !validUtf8) return whole("바이너리·UTF-8 이외의 변경은 파일 전체를 스테이징하세요.");
  if (file.oldPath || file.submodule || /^(?:old mode |new mode |rename |copy |similarity index |dissimilarity index )/m.test(diff.patch)) return whole("이름·파일 모드·서브모듈 변경은 파일 전체를 스테이징하세요.");
  if (/^(?:new file mode|deleted file mode) (?!100644|100755)/m.test(diff.patch) || /^index [a-f0-9]+\.\.[a-f0-9]+ (?!100644|100755)/m.test(diff.patch)) return whole("링크 등 특수 파일은 전체를 스테이징하세요.");
  const lines = diff.patch.split("\n"), hunks: ScmHunk[] = [];
  if (lines.filter((line) => line.startsWith("diff --git ")).length !== 1 || !lines.some((line) => line.startsWith("--- ")) || !lines.some((line) => line.startsWith("+++ "))) return whole("파일 단위 변경만 사용할 수 있습니다.");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/);
    if (!match) continue;
    const next = lines.findIndex((line, at) => at > i && line.startsWith("@@ ")), end = next < 0 ? lines.length - (lines.at(-1) === "" ? 1 : 0) : next;
    const body = lines.slice(i + 1, end); let oldCount = 0, newCount = 0;
    for (const line of body) {
      if (line.startsWith(" ")) { oldCount++; newCount++; }
      else if (line.startsWith("-")) oldCount++;
      else if (line.startsWith("+")) newCount++;
      else if (!line.startsWith("\\ ")) return whole("변경 구간 형식을 확인하지 못했습니다. 파일 전체를 사용하세요.");
    }
    if (oldCount !== Number(match[2] ?? 1) || newCount !== Number(match[4] ?? 1)) return whole("변경 구간 길이를 확인하지 못했습니다. 파일 전체를 사용하세요.");
    hunks.push({ id: scmHash(JSON.stringify([diff.revision, i, lines.slice(i, end)])), patchLine: i, lineCount: end - i, oldStart: Number(match[1]), oldCount, newStart: Number(match[3]), newCount });
    i = end - 1;
  }
  return hunks.length ? { hunks } : whole("텍스트 구간이 없는 변경은 파일 전체를 스테이징하세요.");
}

export function selectedHunkPatch(diff: ScmDiff, selection: ScmHunkSelection) {
  if (diff.revision !== selection.expectedRevision) throw new HttpError(409, "scm_changed", "검토한 변경 구간이 바뀌었습니다. 새로고침한 뒤 선택하세요.");
  if (!diff.hunks?.length || diff.partialReason) throw new HttpError(409, "scm_hunks", diff.partialReason ?? "구간별 스테이징을 사용할 수 없습니다.");
  const chosen = diff.hunks.filter((hunk) => selection.hunks.includes(hunk.id));
  if (chosen.length !== selection.hunks.length) throw new HttpError(409, "scm_hunks", "현재 검토에 없는 변경 구간입니다.");
  const lines = diff.patch.split("\n");
  return [...lines.slice(0, diff.hunks[0]!.patchLine), ...chosen.flatMap((hunk) => lines.slice(hunk.patchLine, hunk.patchLine + hunk.lineCount))].join("\n") + "\n";
}

import type { Work } from "@workbench/contracts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

export function ProjectDeleteDialog({ work, sessions, trashedDocuments = 0, onDelete, onClose }: { work: Work; sessions: number; trashedDocuments?: number; onDelete(): Promise<void>; onClose(): void }) {
  return <ConfirmDialog
    title={`「${work.title}」 프로젝트를 삭제할까요?`}
    lines={[`이 앱의 프로젝트와 대화 ${sessions}개를 삭제합니다. 삭제한 대화 기록은 되돌릴 수 없습니다.`, "문서 파일과 작업 폴더는 그대로 보존합니다.", work.cwd,
      ...(trashedDocuments ? [`앱 휴지통에 있는 이 프로젝트의 문서 ${trashedDocuments}개는 보관함에 남아 다른 곳에 저장하거나 영구 삭제할 수 있습니다.`] : []),
      "목록에서 뺀 문서의 기록은 프로젝트와 함께 지워집니다. 그 파일은 그대로 둡니다."]}
    confirmLabel="프로젝트 삭제"
    busyLabel="삭제 중…"
    onConfirm={onDelete}
    onClose={onClose}
  />;
}

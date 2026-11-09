import type { OfficeUiAdapter } from "../ui-adapters.ts";

/** Original 마인드맵 menu IDs plus the live renderer's existing ribbon controls. */
export const mindmapAdapter: OfficeUiAdapter = {
  label: "마인드맵",
  roots: ".ribbon, .toolbar, [role=toolbar], [role=menubar], [role=tablist]",
  commands: [
    ["save", "저장", "파일", "Ctrl+S"],
    ["save-as", "다른 이름으로 저장", "파일", "Ctrl+Shift+S"],
    ["undo", "실행 취소", "편집", "Ctrl+Z"],
    ["redo", "다시 실행", "편집", "Ctrl+Shift+Z"],
    ["add-child", "하위 주제 넣기", "구조"],
    ["add-sibling", "같은 단계 주제 넣기", "구조"],
    ["fold-all", "모두 접기", "보기"],
    ["unfold-all", "모두 펼치기", "보기"],
    ["zoom-in", "확대", "보기"],
    ["zoom-out", "축소", "보기"],
    ["zoom-reset", "기본 배율", "보기"],
    ["zoom-fit", "전체 지도에 맞춤", "보기"],
    ["print", "인쇄", "파일", "Ctrl+P"],
  ],
};

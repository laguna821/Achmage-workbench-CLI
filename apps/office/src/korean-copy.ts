/**
 * Words a teacher reads in the vendored editors, said in plain Korean (design review, the editors' copy
 * list; I7's rail tooltip). Applied at build time by the `workbench-korean-copy` plugin in
 * apps/office/vite.config.ts — the vendored source is not edited. Each `from` must occur exactly once
 * in its file, and every entry must be applied, or the build fails (the source changed: review here).
 * `file` is relative to vendor/ieumoffice.
 */
export type KoreanCopy = { file: string; from: string; to: string; why: string };

const RAIL = "열린 문서를 바로 고치는 AI 도우미";
const rail = (file: string, from: string): KoreanCopy => ({ file, from: `aiOpenAssistant: '${from}',`, to: `aiOpenAssistant: '${RAIL}',`, why: "the rail key beside the page is the editor's own AI; it says how it differs from 문서 AI (I7)" });

/** PDF 양식 채우기 / 양식 만들기 and 글 넣기 had no Korean (Ieum shows English). */
const PDF_FORM_KO = {
  ribbonTabFillForm: "양식 채우기",
  formPreviousField: "이전 칸",
  formNextField: "다음 칸",
  insertText: "글 넣기",
  insertTextHint: "PDF에 찾을 수 있는 글을 넣습니다",
  insertTextTitle: "글 넣기",
  editInsertedText: "넣은 글 고치기",
  deleteInsertedText: "넣은 글 지우기",
  insertedTextDeleted: "넣은 글을 지웠습니다",
  textInsertSkipped: "{pages}쪽에 넣은 글을 저장하지 못했습니다",
  textInsertNoFont: "이 글을 PDF에 그릴 글꼴이 없습니다. 이모지와 특수 기호는 넣을 수 없습니다",
  formComplete: "다 채움",
  formMissingRequired: "꼭 채울 칸 {count}개가 비어 있습니다",
  formCompleteDone: "양식을 다 채웠습니다",
  formSignField: "눌러서 서명",
  formAddText: "글 놓기",
  formAddTextHint: "글을 쓰고 페이지를 눌러 놓습니다",
  formAddTextTitle: "PDF에 글 놓기",
  formEditText: "글 고치기",
  formAddTextPlaceholder: "놓을 글을 쓰세요",
  formTextSize: "글자 크기",
  formTextColor: "색",
  formTextAlign: "정렬",
  formAlignLeft: "왼쪽",
  formAlignCenter: "가운데",
  formAlignRight: "오른쪽",
  formAddCheck: "체크 표시",
  formAddCheckHint: "페이지를 눌러 체크 표시를 놓습니다",
  formAddCross: "X 표시",
  formAddCrossHint: "페이지를 눌러 X 표시를 놓습니다",
  formPlaceStaticHint: "눌러서 놓고, 놓은 것을 골라 옮기거나 크기를 바꿉니다",
  ribbonTabFormDesign: "양식 만들기",
  formDesignText: "글 칸",
  formDesignTextHint: "페이지를 누르거나 끌어 채울 수 있는 글 칸을 넣습니다",
  formDesignCheckbox: "체크 칸",
  formDesignCheckboxHint: "페이지를 누르거나 끌어 체크 칸을 넣습니다",
  formDesignSignature: "서명 칸",
  formDesignSignatureHint: "페이지를 누르거나 끌어 서명 칸을 넣습니다",
  formDesignDelete: "칸 지우기",
  formDesignDeleted: "칸을 지웠습니다",
  formDesignPending: "새 칸 {count}개는 저장할 때 PDF에 들어갑니다",
  formDesignEmptyHint: "칸 종류를 고른 뒤 페이지를 누르거나 끕니다",
  formDesignRequired: "꼭 채울 칸",
  formDesignMultiLine: "여러 줄",
  formDesignDefaultValue: "처음 값",
  formDesignDefaultChecked: "처음부터 체크",
  formDesignRadio: "하나 고르기 칸",
  formDesignChoice: "목록에서 고르기 칸",
  formDesignDate: "날짜 칸",
  formDesignDetect: "빈칸 찾아 넣기",
  formDesignDetecting: "찾는 중…",
  formDesignArrange: "정렬",
  formDesignProperties: "속성",
  formDesignCopy: "복사",
  formDesignPaste: "붙여넣기",
  formDesignDuplicate: "복제",
  formDesignPreview: "미리 채워 보기",
  formDesignDone: "완료",
  formDatePick: "날짜 고르기",
  formDesignCancel: "취소",
};

export const KOREAN_COPY: KoreanCopy[] = [
  rail("apps/docs/src/renderer/i18n/ai/ko.ts", "AI 도우미 열기"),
  rail("apps/slides/src/renderer/i18n/ai/ko.ts", "AI 도우미 열기"),
  rail("apps/sheets/src/renderer/i18n/ai/ko.ts", "AI 도우미 열기"),
  rail("apps/markdown/src/renderer/i18n/strings.ts", "AI 어시스턴트 열기"),
  rail("apps/pdf/src/renderer/i18n/strings.ts", "AI 어시스턴트 열기"),
  rail("apps/html/src/renderer/i18n/ai/ko.ts", "AI 어시스턴트 열기"),
  { file: "apps/docs/src/renderer/i18n/ribbon/ko.ts", from: "ribbonAiAssistantTip: 'AI 도우미 열기',", to: `ribbonAiAssistantTip: '${RAIL}',`, why: "the ribbon's key to the same panel (I7)" },
  { file: "apps/pdf/src/renderer/i18n/strings.ts", from: "const localizedFillFormStrings = {\n", to: `const localizedFillFormStrings = {\n  ko: ${JSON.stringify(PDF_FORM_KO)},\n`, why: "PDF ribbon read Fill Form, Form Design, Insert text" },
  { file: "apps/pdf/src/renderer/i18n/strings.ts", from: "aiToolInsertText: '{page}페이지에 텍스트 삽입',", to: "aiToolInsertText: '{page}쪽에 글 넣기',", why: "the AI's step, in the ribbon's words" },
  { file: "apps/sheets/src/renderer/i18n/app/ko.ts", from: "'통합 문서를 모두 로드했습니다 — 수식이 실시간으로 다시 계산되고 행/열을 편집할 수 있습니다.',", to: "'다 열었습니다.',", why: "a developer's sentence shown in two places" },
  { file: "packages/ui/src/strings-ai-subscription/ko.ts", from: "스스로 쓰기\"로 둔 스킬의 이름·제목·설명이 함께 가고, 쓰는 스킬의 글과 AI가 읽은 스킬 파일도 함께 전송됩니다.", to: "스스로 쓰기\"로 둔 양식의 이름과 설명이 함께 가고, 쓰는 양식의 글과 AI가 읽은 양식 파일도 함께 전송됩니다.", why: "스킬 and middle dots in every editor's first-use notice" },
  { file: "packages/ui/src/strings-ai-subscription/ko.ts", from: "다만 Codex가 자체 진단 로그를 이 PC에 남길 수 있습니다.", to: "다만 Codex가 자체 기록을 이 PC에 남길 수 있습니다.", why: "진단 로그 is a developer's word" },
  { file: "packages/ui/src/strings-ai-subscription/ko.ts", from: "usageLine: '{percent}% 사용 · {time}에 초기화',", to: "usageLine: '{percent}% 사용, {time}에 초기화',", why: "no middle dots" },
  { file: "packages/ui/src/strings-ai-subscription/ko.ts", from: "pickerAutoUsing: '자동 · {provider}',", to: "pickerAutoUsing: '{provider}',", why: "the composer read 자동 · Claude (truncated 자… in Word)" },
  { file: "packages/ui/src/strings-ai-subscription/ko.ts", from: "pickerAutoUsingModel: '자동 · {provider} · {model}',", to: "pickerAutoUsingModel: '{provider}, {model}',", why: "no middle dots" },
];

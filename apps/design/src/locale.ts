import { TEXT_PRESETS } from "@/editor/engine/objects/factories";
import { t } from "@/editor/strings";
import { SAMETONE } from "./fonts";

// Workbench is used in Korean: the editor's most visible words are replaced at start-up (doory keeps
// every visible string in one object for translation). Anything not listed stays in English.

type Overlay = { [key: string]: string | ((...args: never[]) => string) | Overlay };

const ko: Overlay = {
  appLabel: "디자인 편집기",
  untitled: "제목 없는 디자인",
  topbar: {
    file: "파일",
    view: "보기",
    menu: "메뉴",
    downloadHeading: "내보내기",
    present: "발표",
    presentHeading: "발표",
    presentFull: "전체 화면 발표",
    undo: "되돌리기",
    redo: "다시 하기",
    title: "디자인 제목",
    moreDownloadOptions: "다른 형식…",
    videoDownload: "영상 또는 GIF…",
    formatHint: { jpg: "작은 파일", png: "투명 배경", pdf: "인쇄용", svg: "벡터" },
  },
  menu: {
    newPage: "페이지 추가",
    rulers: "눈금자 보기",
    grid: "격자 보기",
    guides: "정렬 안내선 보기",
    snapping: "안내선에 맞추기",
    bleed: "인쇄 여백 보기",
    safeZone: "안전 영역 보기",
  },
  save: {
    saving: "저장 중…",
    saved: "저장됨",
    local: "저장됨",
    unsaved: "저장 안 됨",
    conflict: "충돌",
    error: "저장 실패",
    retry: "다시 저장",
    readOnly: "읽기 전용",
    conflictTitle: "이 디자인이 다른 곳에서 바뀌었습니다",
    conflictBody: "AI 수정안 적용이나 다른 편집으로 새 판이 생겼습니다. 내 편집은 이 창에 그대로 있습니다.",
    reload: "최신 판 열기",
    keepEditing: "내 편집을 사본으로 저장",
    dismiss: "닫기",
  },
  dialog: {
    downloadTitle: "내보내기",
    downloadFormat: "파일 형식",
    downloadPages: "페이지",
    downloadAllPages: "모든 페이지",
    downloadCurrentPage: "현재 페이지",
    downloadRange: "페이지 선택",
    downloadRangeHint: "예: 1-3, 5",
    downloadScale: "크기",
    downloadQuality: "품질",
    downloadTransparent: "투명 배경",
    downloadButton: "작업 폴더에 저장",
    downloadWorking: "만드는 중…",
    downloadDone: "작업 폴더에 저장했습니다",
    downloadCopy: "이미지로 복사",
    downloadCopied: "클립보드에 복사했습니다",
    downloadFailed: "내보내기에 실패했습니다.",
  },
  chrome: { tools: "디자인에 추가", more: "더 보기", back: "뒤로" },
  drawers: {
    addText: "글자 추가",
    heading: "제목",
    addHeading: "제목 추가",
    subheading: "부제목",
    addSubheading: "부제목 추가",
    body: "본문",
    addBody: "본문 추가",
    curvedText: "곡선 글자",
    arcUp: "위로 휘기",
    arcDown: "아래로 휘기",
    linesAndArrows: "선과 화살표",
    arrow: "화살표",
    doubleArrow: "양쪽 화살표",
    dottedLine: "점선",
    moreShapes: "더 많은 도형",
    tools: "도구",
    qrCode: "QR 코드",
    photoPlaceholder: "사진 틀",
    charts: "차트",
    pairings: "글꼴 조합",
    lists: "목록",
    bulleted: "글머리표 목록",
    numbered: "번호 목록",
    basicShapes: "기본 도형",
    decorative: "장식",
    divider: "구분선",
  },
  pagesPill: { toggle: "페이지 썸네일 보기", hide: "페이지 썸네일 숨기기", group: "페이지", add: "페이지 추가" },
  rail: {
    text: "글자",
    elements: "스티커",
    image: "이미지",
    animate: "애니메이션",
    shapes: "도형",
    templates: "템플릿",
    background: "배경",
    layers: "레이어",
    audio: "소리",
  },
  panels: {
    textTitle: "글자",
    uploadsTitle: "올린 파일",
    backgroundTitle: "배경",
    layersTitle: "레이어",
    pagesTitle: "페이지",
    searchFonts: "글꼴 찾기",
    noResults: "찾는 항목이 없습니다.",
    loadFailed: "목록을 불러오지 못했습니다.",
    retry: "다시 시도",
    loadMore: "더 불러오기",
    shapes: "기본 도형",
    addHeading: "제목 추가",
    addSubheading: "부제목 추가",
    addBody: "본문 추가",
  },
  textPanel: {
    more: "더 보기",
    curved: "곡선 글자",
    bulleted: "글머리표 목록",
    numbered: "번호 목록",
    headingText: "제목",
    subheadingText: "부제목",
    bodyText: "본문을 입력하세요",
  },
  workspace: {
    page: (i: number) => `${i}쪽`,
    pageOf: (n: number, total: number) => `${n} / ${total}쪽`,
    addPage: "페이지 추가",
    addPageHere: "여기에 페이지 추가",
    duplicatePage: "페이지 복제",
    deletePage: "페이지 삭제",
    moveUp: "위로 옮기기",
    moveDown: "아래로 옮기기",
    renamePage: "페이지 이름 바꾸기",
    emptyHint: "왼쪽 도구로 글자·도형·이미지를 넣거나 파일을 끌어다 놓으세요.",
    zoomIn: "확대",
    zoomOut: "축소",
    fitWidth: "너비 맞춤",
    fitPage: "페이지 맞춤",
  },
};

function merge(target: Record<string, unknown>, overlay: Overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    const current = target[key];
    if (value && typeof value === "object" && current && typeof current === "object") merge(current as Record<string, unknown>, value as Overlay);
    else if (key in target && typeof value === typeof current) target[key] = value;
  }
}

/** Korean labels and SameTone as the type new text starts with. Call before the editor mounts. */
export function localizeEditor() {
  merge(t as unknown as Record<string, unknown>, ko);
  const stack = `"${SAMETONE}", sans-serif`;
  TEXT_PRESETS.heading.font = TEXT_PRESETS.subheading.font = TEXT_PRESETS.body.font = stack;
  TEXT_PRESETS.heading.label = t.textPanel.headingText;
  TEXT_PRESETS.subheading.label = t.textPanel.subheadingText;
  TEXT_PRESETS.body.label = t.textPanel.bodyText;
}

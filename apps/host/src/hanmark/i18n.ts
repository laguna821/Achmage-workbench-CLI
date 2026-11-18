/**
 * The HanMark message catalogue (HanMark 2.7.0 `src/i18n/ko.ts`, MIT © laguna821), cut to the keys the
 * ported files use. Workbench is Korean: interface text is Korean only; text written INTO a document
 * (callout titles, placeholders) keeps HanMark's Korean/English pair, chosen by the document itself.
 * Adapted for Workbench: "Vault"/"HanMark" in the advice lines say what Workbench does instead.
 */

export type Locale = "ko" | "en";
export type LanguagePreference = Locale | "auto";
type Params = Record<string, string | number>;

const ko = {
  "import.preset.default.name": "기본 (권장)",
  "import.preset.default.desc": "원본 구조를 그대로 옮깁니다. 대부분의 문서에 알맞습니다.",
  "import.preset.text.name": "글 위주",
  "import.preset.text.desc": "제목·목록·표 구조는 두고 그림 자리·링크 주소·굵게 표시를 뺀 글만 가져옵니다. 그림은 저장하지 않습니다.",
  "import.preset.form.name": "서식 문서",
  "import.preset.form.desc": "빈 입력 칸, 누름틀 안내문, 빈 줄을 보존합니다. 신청서·양식에 알맞습니다.",
  "import.preset.exam.name": "시험지·안내문 PDF",
  "import.preset.exam.desc": "PDF의 테두리 상자를 표로 읽지 않고 읽는 순서대로 가져옵니다. 표가 있는 PDF에는 쓰지 마세요.",

  "import.error.emptyInput.title": "빈 파일입니다.",
  "import.error.emptyInput.fix": "원본 파일이 제대로 저장됐는지 확인하세요.",
  "import.error.unsupportedFormat.title": "지원하지 않는 형식입니다.",
  "import.error.unsupportedFormat.fix": "HWP·HWPX·DOCX·XLSX·XLS 파일을 고르세요. PPTX는 아직 읽을 수 없습니다.",
  "import.error.encrypted.title": "암호가 걸린 문서입니다.",
  "import.error.encrypted.fix": "암호를 입력하면 다시 시도합니다. 암호는 저장하지 않습니다.",
  "import.error.encryptedPdf.fix": "PDF 암호는 지원하지 않습니다. PDF 앱에서 암호를 해제한 뒤 불러오세요.",
  "import.error.drm.title": "문서 보안(DRM)이 걸린 문서입니다.",
  "import.error.drm.fix": "한컴오피스에서 보안을 해제해 다시 저장한 뒤 불러오세요. 이 앱은 문서 보안을 풀지 않습니다.",
  "import.error.corrupted.title": "파일이 손상됐거나 완전하지 않습니다.",
  "import.error.corrupted.fix": "원본을 다시 받거나, 한컴오피스에서 다른 이름으로 저장한 뒤 다시 불러오세요.",
  "import.error.bomb.title": "압축을 풀면 비정상적으로 커지는 파일이라 안전을 위해 멈췄습니다.",
  "import.error.bomb.fix": "믿을 수 있는 출처의 파일인지 확인하세요.",
  "import.error.imagePdf.title": "글자 없이 그림으로만 된 PDF(스캔본)입니다.",
  "import.error.imagePdf.fix": "이 앱은 문자 인식(OCR)을 하지 않습니다. OCR 도구로 글자를 넣은 PDF를 만든 뒤 불러오세요.",
  "import.error.noSections.title": "문서에서 본문을 찾지 못했습니다.",
  "import.error.parse.title": "문서를 읽는 중 오류가 났습니다.",
  "import.error.parse.fix": "HWPX 같은 다른 형식으로 저장해 다시 시도하세요. 계속 실패하면 원문 메시지와 함께 알려 주세요.",
  "import.error.missingDependency.title": "이 작업에 필요한 구성 요소가 앱에 없습니다.",
  "import.error.missingDependency.fix": "문자 인식(OCR)·PDF 읽기 같은 추가 구성 요소는 이 버전에 들어 있지 않습니다(오프라인 원칙).",
  "import.error.tooLarge.title": "결과가 너무 커서 한 문서로 만들 수 없습니다.",
  "import.error.tooLarge.fix": "쪽 범위로 나눠 여러 번 불러오세요.",
  "import.error.notFound.title": "파일을 찾을 수 없습니다.",
  "import.error.notFound.fix": "파일을 옮기거나 지웠는지 확인하세요.",

  "import.warning.skippedImage": "그림 하나를 읽지 못해 건너뛰었습니다.",
  "import.warning.skippedOle": "삽입된 개체(OLE)는 가져오지 않았습니다.",
  "import.warning.truncatedTable": "표가 너무 커서 일부만 가져왔습니다.",
  "import.warning.ocrFallback": "문자 인식 대신 기본 추출 결과를 사용했습니다.",
  "import.warning.unsupportedElement": "지원하지 않는 요소를 건너뛰었습니다.",
  "import.warning.brokenZip": "손상된 파일 구조를 복구해 읽었습니다. 일부 내용이 빠졌을 수 있습니다.",
  "import.warning.hiddenText": "숨은 글자나 반복되는 머리글을 걸러 냈습니다.",
  "import.warning.malformedXml": "형식이 어긋난 부분을 건너뛰었습니다.",
  "import.warning.partialParse": "문서의 일부만 읽었습니다.",
  "import.warning.lenientCfb": "손상된 HWP 구조를 너그럽게 읽었습니다. 내용을 확인하세요.",
  "import.warning.needsOcr": "글자가 없거나 깨진 쪽입니다(스캔본일 수 있습니다). 이 앱은 문자 인식을 하지 않습니다.",
  "import.warning.ocrFailed": "문자 인식에 실패했습니다.",
  "import.warning.ocrApplied": "문자 인식 결과를 사용했습니다.",
  "import.warning.ocrLowConfidence": "문자 인식 결과의 신뢰도가 낮습니다.",
  "import.warning.comEmpty": "외부 변환 결과가 비어 있습니다.",
  "import.warning.drmComFallback": "문서 보안 해제 경로는 이 앱에서 쓰지 않습니다.",
  "import.warning.pageApproximate": "쪽 정보가 없는 문서라 쪽 범위를 구역 단위로 적용했습니다.",

  "import.image.unreferenced": "본문 참조를 찾지 못해 이미지를 저장하지 않았습니다: {file}",
  "import.image.saveFailed": "이미지 저장 실패 ({file}): {detail}",

  "adapter.warning.fileEmbedFlattened": "그림이 아닌 파일 임베드(PDF·오디오 등)는 이름만 남습니다.",
  "adapter.warning.noteEmbedFlattened": "노트 임베드는 링크 텍스트로 펼쳐집니다. 포함된 노트 본문은 자동 삽입되지 않습니다.",
  "adapter.warning.calloutFlattened": "콜아웃(> [!note] 같은 상자)은 제목이 있는 인용문으로 바뀝니다.",
  "adapter.warning.highlightFlattened": "형광펜 표시는 일반 텍스트로 변환됩니다.",
  "adapter.warning.footnoteUndefined": "정의가 없는 각주 표시는 글자 그대로 남습니다: {ids}",

  "save.imageFailure.image": "이미지",

  "image.unsupported": "지원하지 않거나 손상된 이미지입니다. PNG·JPEG·GIF·BMP를 사용하세요.",
  "image.noDimensions": "이미지 크기 정보를 읽을 수 없습니다.",
  "image.tooManyPixels": "이미지 픽셀 크기가 너무 큽니다: {width}×{height}",
  "image.tooMany": "문서당 이미지 한도 {limit}개를 넘었습니다.",
  "image.empty": "이미지 데이터가 비어 있습니다.",
  "image.fileTooLarge": "이미지 한 개의 용량 한도 {limit}MiB를 넘었습니다.",
  "image.totalTooLarge": "문서 이미지 총용량 한도 {limit}MiB를 넘었습니다.",
  "image.resolutionFailed": "이미지 {count}개를 포함하지 못했습니다.",

  "output.callout.note": "참고", "output.callout.info": "정보", "output.callout.tip": "팁", "output.callout.warning": "주의",
  "output.callout.caution": "주의", "output.callout.danger": "위험", "output.callout.error": "오류", "output.callout.example": "예시",
  "output.callout.quote": "인용", "output.callout.question": "질문", "output.callout.success": "완료", "output.callout.failure": "실패",
  "output.callout.bug": "버그", "output.callout.todo": "할 일",
  "output.embedPlaceholder": "[임베드: {name}]",
  "image.output.defaultAlt": "이미지",
  "image.output.missing": "[이미지 누락: {name}]",

  "common.unknownError": "알 수 없는 오류",
} as const;

export type MessageKey = keyof typeof ko;

/** Only text written into an English document has an English form (HanMark `en.ts`). */
const en: Partial<Record<MessageKey, string>> = {
  "output.callout.note": "Note", "output.callout.info": "Info", "output.callout.tip": "Tip", "output.callout.warning": "Warning",
  "output.callout.caution": "Caution", "output.callout.danger": "Danger", "output.callout.error": "Error", "output.callout.example": "Example",
  "output.callout.quote": "Quote", "output.callout.question": "Question", "output.callout.success": "Success", "output.callout.failure": "Failure",
  "output.callout.bug": "Bug", "output.callout.todo": "To do",
  "output.embedPlaceholder": "[Embed: {name}]",
  "image.output.defaultAlt": "Image",
  "image.output.missing": "[Missing image: {name}]",
};

function fill(template: string, params?: Params) {
  return params ? template.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all)) : template;
}

export function containsHangul(text: string): boolean {
  return /[ᄀ-ᇿ㄰-㆏가-힯]/u.test(text);
}

/** "auto" reads the document itself: Korean when it contains Hangul, English otherwise. */
export function resolveOutputLocale(preference: unknown, documentText: string): Locale {
  if (preference === "ko" || preference === "en") return preference;
  return containsHangul(documentText) ? "ko" : "en";
}

export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return fill((locale === "en" ? en[key] : undefined) ?? ko[key], params);
}

/** Interface text (Korean). */
export function t(key: MessageKey, params?: Params): string {
  return translate("ko", key, params);
}
export const tKey = t;

/** Text written into a document, in the document's language. */
export function tOut(locale: Locale, key: MessageKey, params?: Params): string {
  return translate(locale, key, params);
}

export function errorMessage(error: unknown, fallback = t("common.unknownError")): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

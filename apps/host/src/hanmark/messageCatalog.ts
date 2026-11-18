// Ported from HanMark 2.7.0 src/io/messageCatalog.ts @ 3db078d (MIT © 2026 laguna821, ./LICENSE-HANMARK). Workbench: kordoc's code types named locally; texts in ./i18n.ts.
import { tKey, type MessageKey } from "./i18n.ts";

/** kordoc 4.18.13's structured codes (its `ErrorCode`, `WarningCode`, `FileType`), named here as the plugin's types did. */
type ErrorCode = "EMPTY_INPUT" | "UNSUPPORTED_FORMAT" | "ENCRYPTED" | "DRM_PROTECTED" | "CORRUPTED" | "DECOMPRESSION_BOMB" | "ZIP_BOMB" | "IMAGE_BASED_PDF" | "NO_SECTIONS" | "PARSE_ERROR" | "MISSING_DEPENDENCY" | "OUTPUT_TOO_LARGE" | "FILE_NOT_FOUND";
type WarningCode = "SKIPPED_IMAGE" | "SKIPPED_OLE" | "TRUNCATED_TABLE" | "OCR_FALLBACK" | "UNSUPPORTED_ELEMENT" | "BROKEN_ZIP_RECOVERY" | "HIDDEN_TEXT_FILTERED" | "MALFORMED_XML" | "PARTIAL_PARSE" | "LENIENT_CFB_RECOVERY" | "NEEDS_OCR" | "OCR_FAILED" | "OCR_APPLIED" | "OCR_LOW_CONF" | "COM_EMPTY" | "DRM_COM_FALLBACK" | "PAGE_BOUNDARY_APPROXIMATE";
type FileType = string;
type ParseWarning = { code?: string; message: string };

/**
 * Plain-language explanations for Kordoc's structured codes (2.7.0 W2/W3).
 *
 * Users see a localized title and, for failures, what to do next. Kordoc's own
 * sentence stays available as "original message" for bug reports, never as the
 * main text.
 */
interface ErrorEntry {
  title: MessageKey;
  fix?: MessageKey;
}

const ERRORS: Readonly<Record<ErrorCode, ErrorEntry>> = {
  EMPTY_INPUT: { title: "import.error.emptyInput.title", fix: "import.error.emptyInput.fix" },
  UNSUPPORTED_FORMAT: { title: "import.error.unsupportedFormat.title", fix: "import.error.unsupportedFormat.fix" },
  ENCRYPTED: { title: "import.error.encrypted.title", fix: "import.error.encrypted.fix" },
  DRM_PROTECTED: { title: "import.error.drm.title", fix: "import.error.drm.fix" },
  CORRUPTED: { title: "import.error.corrupted.title", fix: "import.error.corrupted.fix" },
  DECOMPRESSION_BOMB: { title: "import.error.bomb.title", fix: "import.error.bomb.fix" },
  ZIP_BOMB: { title: "import.error.bomb.title", fix: "import.error.bomb.fix" },
  IMAGE_BASED_PDF: { title: "import.error.imagePdf.title", fix: "import.error.imagePdf.fix" },
  NO_SECTIONS: { title: "import.error.noSections.title", fix: "import.error.corrupted.fix" },
  PARSE_ERROR: { title: "import.error.parse.title", fix: "import.error.parse.fix" },
  MISSING_DEPENDENCY: { title: "import.error.missingDependency.title", fix: "import.error.missingDependency.fix" },
  OUTPUT_TOO_LARGE: { title: "import.error.tooLarge.title", fix: "import.error.tooLarge.fix" },
  FILE_NOT_FOUND: { title: "import.error.notFound.title", fix: "import.error.notFound.fix" }
};

const WARNINGS: Readonly<Record<WarningCode, MessageKey>> = {
  SKIPPED_IMAGE: "import.warning.skippedImage",
  SKIPPED_OLE: "import.warning.skippedOle",
  TRUNCATED_TABLE: "import.warning.truncatedTable",
  OCR_FALLBACK: "import.warning.ocrFallback",
  UNSUPPORTED_ELEMENT: "import.warning.unsupportedElement",
  BROKEN_ZIP_RECOVERY: "import.warning.brokenZip",
  HIDDEN_TEXT_FILTERED: "import.warning.hiddenText",
  MALFORMED_XML: "import.warning.malformedXml",
  PARTIAL_PARSE: "import.warning.partialParse",
  LENIENT_CFB_RECOVERY: "import.warning.lenientCfb",
  NEEDS_OCR: "import.warning.needsOcr",
  OCR_FAILED: "import.warning.ocrFailed",
  OCR_APPLIED: "import.warning.ocrApplied",
  OCR_LOW_CONF: "import.warning.ocrLowConfidence",
  COM_EMPTY: "import.warning.comEmpty",
  DRM_COM_FALLBACK: "import.warning.drmComFallback",
  PAGE_BOUNDARY_APPROXIMATE: "import.warning.pageApproximate"
};

/** Formats whose open password Kordoc can use (HWPX: AES, HWP 3: DES). */
const PASSWORD_FORMATS: ReadonlySet<FileType> = new Set<FileType>(["hwpx", "hwp3"]);

export interface ImportFailureText {
  title: string;
  fix?: string;
  /** True when entering a password can make the next attempt succeed. */
  passwordHelps: boolean;
}

function knownError(code: unknown): code is ErrorCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(ERRORS, code);
}

function knownWarning(code: unknown): code is WarningCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(WARNINGS, code);
}

export function describeImportFailure(code: unknown, fileType?: FileType): ImportFailureText {
  if (!knownError(code)) {
    return { title: tKey("import.error.parse.title"), fix: tKey("import.error.parse.fix"), passwordHelps: false };
  }
  if (code === "ENCRYPTED" && fileType === "pdf") {
    return {
      title: tKey("import.error.encrypted.title"),
      fix: tKey("import.error.encryptedPdf.fix"),
      passwordHelps: false
    };
  }
  const entry = ERRORS[code];
  return {
    title: tKey(entry.title),
    fix: entry.fix ? tKey(entry.fix) : undefined,
    passwordHelps: code === "ENCRYPTED" && (fileType === undefined || PASSWORD_FORMATS.has(fileType))
  };
}

/** Localized sentence for one Kordoc warning; unknown codes keep Kordoc's text. */
export function describeImportWarning(warning: Pick<ParseWarning, "code" | "message">): string {
  return knownWarning(warning.code) ? tKey(WARNINGS[warning.code]) : warning.message;
}

export const KORDOC_ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];
export const KORDOC_WARNING_CODES = Object.keys(WARNINGS) as WarningCode[];

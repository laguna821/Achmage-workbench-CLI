// @genoffice/electron-utils as the slides editor code uses it inside Workbench: there are no file
// dialogs, menus, crash-recovery folders or other windows here (Workbench keeps revisions and the
// page keeps unsaved edits), so these answer "nothing to do"; file writes go to fs.ts.
import path from "path-browserify";

const { posix } = path;
import { renameSync, writeFileSync } from "./fs.ts";

const noop = () => {};

// ── identity, settings, menus ────────────────────────────────────────────
export const MAX_REMOTE_IMAGE_BYTES = 50 * 1024 * 1024;
export const isHeadlessMode = () => false;
export const configuredAuthorName = () => "";
export const configuredDefaultSaveDir = () => "/documents";
export const appMenuLabels = () => ({});
export const contextMenuLabels = () => ({});
export const helpMenuTemplate = () => [];
export const viewMenuTemplate = () => [];
export const windowMenuTemplate = () => [];
export const toggleDevToolsItem = () => ({ visible: false });
export const installContextMenu = noop;
export const installNavigationGuard = noop;
export const installRendererProtocol = noop;
export const registerRendererScheme = noop;
export const rendererUrl = () => "";
export const saveAsSuggestion = (source: string | null | undefined, name: string) => (source ? posix.join(posix.dirname(source), name) : name);

export function safeExternalUrl(url: unknown, options?: { allowedProtocols?: readonly string[] }) {
  if (typeof url !== "string") return null;
  const text = url.trim();
  try {
    return (options?.allowedProtocols ?? ["http:", "https:"]).includes(new URL(text).protocol) ? text : null;
  } catch {
    return null;
  }
}

// ── files on disk: one working copy, never shared, never changed behind the editor ─────────
export const recordDiskState = async () => null;
export const isModifiedSince = async () => false;
export const isPathOpenElsewhere = () => false;
export const shouldDeferAutoSave = async () => false;
export const confirmOverwriteIfConflicted = async () => "overwrite" as const;
export const showOpenDialogWithMemory = async () => ({ canceled: true, filePaths: [] as string[] });
export const showSaveDialogWithMemory = async () => ({ canceled: true, filePath: undefined });

export async function atomicWriteFile(path: string, data: Uint8Array | string) {
  writeFileSync(path, data);
}
export function writeJsonAtomic(path: string, value: unknown) {
  writeFileSync(path, JSON.stringify(value));
}
/** Workbench saves what the editor holds; there is no other unsaved copy of a file to wait for. */
export const assertFileSaved = async () => undefined;
export async function atomicWriteVia(path: string, write: (temp: string) => Promise<void>) {
  const temp = `${path}.saving`;
  await write(temp);
  renameSync(temp, path);
}

// ── remote images (used by AI features only) ─────────────────────────────
export const fetchRemoteImage = async () => null;
export const readBodyCapped = async () => {
  throw new Error("Workbench에서는 웹 이미지를 직접 받지 않습니다.");
};

// ── app lifetime, printing ───────────────────────────────────────────────
let shuttingDown = false;
export const isAppShuttingDown = () => shuttingDown;
export const markAppShuttingDown = () => {
  shuttingDown = true;
};
export const resetAppShuttingDown = () => {
  shuttingDown = false;
};
/** Ends an operation when its page goes away; returns the unsubscribe. */
export const abortOnDestroyed = () => () => undefined;
export const buildPrintableHtml = () => "";
export const printHtmlToPdf = async () => {
  throw new Error("PDF 내보내기는 Workbench에서 아직 지원하지 않습니다.");
};

// ── crash recovery: the editor page keeps unsaved edits itself ───────────
type Identity = { kind: string; filePath?: string; untitledId?: string; ext?: string };
export const recoveryFolderName = (kind: string) => `${kind}-recovery`;
export const resumeDiscardedCopies = () => undefined;
export const unprotectableNoticeText = () => "";
export const isUntitledIdentity = (identity: Identity) => typeof identity?.untitledId === "string";
export const newUntitledRecoveryId = () => crypto.randomUUID();
export const registerRecoveryEditor = noop;
export const resolveRecoveryOnOpen = async () => ({ action: "original" as const });
export function createRecoveryStore() {
  return {
    isDiscarded: () => false,
    copyPath: (identity: Identity) => `/recovery/${identity.filePath ?? identity.untitledId ?? "copy"}`,
    copyInfo: () => null,
    beginWrite: () => ({}),
    writeCopy: async () => "skipped" as const,
    writeCopyStreamed: async () => "skipped" as const,
    deleteCopy: () => "deleted" as const,
    readCopy: async () => null,
    markCopyLoaded: noop,
    setCopyState: noop,
    adoptUntitledCopy: () => null,
    listCopies: () => [],
    openPlan: () => ({ action: "original" as const }),
  };
}

// ── password-protected decks: not opened in Workbench yet ────────────────
export class OfficeDecryptError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}
export const isEncryptedOoxml = () => false;
export const isEncryptedOfficeFile = () => false;
/** An OLE compound file (a legacy .xls/.doc, or a password-protected package). */
export const isCfbHeader = (bytes: Uint8Array) =>
  bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1;
export const decryptOfficeFile = async () => {
  throw new OfficeDecryptError("unsupported", "암호가 걸린 문서는 Workbench에서 아직 열지 못합니다.");
};
export const unlockOfficeFile = decryptOfficeFile;
export const encryptOoxml = () => {
  throw new OfficeDecryptError("unsupported", "암호가 걸린 문서는 Workbench에서 아직 저장하지 못합니다.");
};

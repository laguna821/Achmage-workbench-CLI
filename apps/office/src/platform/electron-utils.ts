// @genoffice/electron-utils as the slides editor code uses it inside Workbench: there are no file
// dialogs, menus, crash-recovery folders or other windows here (Workbench keeps revisions and the
// page keeps unsaved edits), so these answer "nothing to do"; file writes go to fs.ts.
import { posix } from "path-browserify";
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

// ── crash recovery: the editor page keeps unsaved edits itself ───────────
type Identity = { kind: string; filePath?: string; untitledId?: string; ext?: string };
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
export const decryptOfficeFile = async () => {
  throw new OfficeDecryptError("unsupported", "암호가 걸린 문서는 Workbench에서 아직 열지 못합니다.");
};
export const unlockOfficeFile = decryptOfficeFile;
export const encryptOoxml = () => {
  throw new OfficeDecryptError("unsupported", "암호가 걸린 문서는 Workbench에서 아직 저장하지 못합니다.");
};

// Extracted from Paseo 1fff127f45b11c1c9c573fbbd12791673004c912, Apache-2.0.
// Original modules and their hashes are preserved in upstream/ and source.json.
import { resolveRasterImageMimeType } from "./file-types.ts";

export interface ClipboardItemLike {
  kind?: string;
  type?: string;
  getAsFile?: () => File | null;
}

export interface ClipboardDataLike {
  items?: ArrayLike<ClipboardItemLike> | null;
}


export interface ClipboardImageFile {
  file: File;
  mimeType: string;
}

export function collectImageFilesFromClipboardData(
  clipboardData?: ClipboardDataLike | null,
): ClipboardImageFile[] {
  if (!clipboardData?.items) {
    return [];
  }

  const files: ClipboardImageFile[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item?.kind !== "file") {
      continue;
    }
    const mimeType = resolveRasterImageMimeType({ mimeType: item.type });
    if (!mimeType) {
      continue;
    }
    const file = item.getAsFile?.();
    if (!file) {
      continue;
    }
    files.push({ file, mimeType });
  }

  return files;
}

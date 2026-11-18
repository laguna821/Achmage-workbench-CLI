import { listen, post } from "./bridge.ts";

// The editors' own "한글 문서로 내보내기" (IeumOffice v0.13.0's menu item) opens the WINDOW's dialog
// (apps/web HangulExportDialog): Word → Hangul through docx2hwp with the ledger asked there before anything is
// written; Markdown → Hangul the HanMark way (kordoc, the owner's direction). The page waits for how it ended.
const pending = new Map<string, (result: { ok: boolean; path?: string }) => void>();
listen((message) => {
  if (message.type !== "office:hangul-export-result") return;
  const waiter = pending.get(message.requestId);
  if (!waiter) return;
  pending.delete(message.requestId);
  waiter({ ok: message.ok, ...(message.path ? { path: message.path } : {}) });
});

/** Ask the window; resolves once, when its dialog ends (`ok`: a Hangul file was made, at `path`). */
export function askHangulExport(document?: { bytes: ArrayBuffer; passwordSet: boolean }): Promise<{ ok: boolean; path?: string }> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    post({ type: "office:hangul-export", requestId, ...(document ? { bytes: document.bytes, passwordSet: document.passwordSet } : {}) });
  });
}

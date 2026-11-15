// Writes Workbench's OWN password test documents (review M7): a short document of our own words with
// one memo, exported by the engine with the password "wb-own-1234" as HWP (EncryptVersion 4) and as
// HWPX (ODF AES-256-CBC). No corpus text, no Hancom sample: CI has no refs-ext, and the password promise
// (opens only with the password, save refused, memos read-only) needs a test there.
// Usage: node scripts/hwp-password-fixtures.ts [--check]
//   --check  regenerate in memory and only verify the committed files still open with the password and
//            carry the same text and memo (exit 1 if not); the bytes differ per run (random salt/IV).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import init, { HwpDocument, ENGINE_DIR } from "../third_party/hop/engine.ts";

export const PASSWORD = "wb-own-1234";
export const OWN_TEXT = "워크벤치 암호 시험 문서입니다";
export const OWN_MEMO = { author: "워크벤치", text: "시험 메모" };
const root = resolve(import.meta.dirname, "..");
export const FIXTURE_DIR = join(root, "apps/host/src/fixtures");
export const FIXTURES = { hwp: join(FIXTURE_DIR, "password-own.hwp"), hwpx: join(FIXTURE_DIR, "password-own.hwpx") };

export function ownPasswordDocuments(): { hwp: Uint8Array; hwpx: Uint8Array } {
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    doc.insertText(0, 0, 0, OWN_TEXT);
    const made = JSON.parse(doc.insertMemo(0, 0, 0, 4, JSON.stringify(OWN_MEMO))) as { ok?: boolean };
    if (!made.ok) throw new Error(`the engine refused the memo: ${JSON.stringify(made)}`);
    return { hwp: doc.exportHwpWithPassword(PASSWORD), hwpx: doc.exportHwpxWithPassword(PASSWORD) };
  } finally { doc.free(); }
}

if (import.meta.main) {
  await init({ module_or_path: readFileSync(join(root, ENGINE_DIR, "rhwp_bg.wasm")) });
  if (process.argv.includes("--check")) {
    for (const [format, path] of Object.entries(FIXTURES)) {
      const doc = HwpDocument.openWithPassword(readFileSync(path), PASSWORD);
      try {
        const info = JSON.parse(doc.getDocumentInfo()) as { encrypted?: boolean };
        const memos = JSON.parse(doc.getMemoList()) as { author?: string; text?: string }[];
        const ok = info.encrypted === true && memos.length === 1 && memos[0]?.text === OWN_MEMO.text;
        console.log(`${ok ? "ok" : "FAIL"} ${format}: encrypted ${info.encrypted}, memos ${memos.length}`);
        if (!ok) process.exitCode = 1;
      } finally { doc.free(); }
    }
  } else {
    const made = ownPasswordDocuments();
    mkdirSync(dirname(FIXTURES.hwp), { recursive: true });
    writeFileSync(FIXTURES.hwp, made.hwp);
    writeFileSync(FIXTURES.hwpx, made.hwpx);
    console.log(`wrote ${FIXTURES.hwp} (${made.hwp.length} B) and ${FIXTURES.hwpx} (${made.hwpx.length} B)`);
  }
}

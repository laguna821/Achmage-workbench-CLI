import { writeFileSync } from "node:fs";
import type { Snapshot } from "@workbench/contracts";
import { shot, until, type Ctx } from "./scenarios.ts";
import { KEY } from "./webdriver.ts";

/** Exercise the original controls after the AI's automatic save, then verify
 * the actual file and revision after each manual save. No editor-state mocks. */
export async function officeUndo(ctx: Ctx, format: string, artifactId: string, marker: string, readSaved: () => Promise<string>, afterUndo?: () => Promise<void>) {
  const { wd, api } = ctx.app, S = `Office Undo ${format}`;
  const revision = async () => (await api<Snapshot>("GET", "/api/snapshot")).artifacts.find((item) => item.id === artifactId)!.revision;
  const key = (value: string) => wd.keys([{ type: "keyDown", value: KEY.control }, { type: "keyDown", value }, { type: "keyUp", value }, { type: "keyUp", value: KEY.control }]);
  const undo = 'button[aria-label^="실행 취소"]:not(:disabled)';
  const redo = 'button[aria-label^="다시 실행"]:not(:disabled)';
  let before = await revision();
  if (format === "hwpx") await wd.frame(await wd.waitFor("iframe"));
  try { for (const action of ["undo", "redo"] as const) {
    const selector = format === "docx" ? (action === "undo" ? ".ai-rollback-btn:not(:disabled)" : undo)
      : action === "undo" && format === "xlsx" ? ".ai-undo-btn:not(:disabled)" : action === "undo" ? undo : redo;
    try {
      if (format === "hwpx") {
        await wd.click(await wd.waitFor('[data-menu="edit"] > .menu-title'));
        await wd.click(await wd.waitFor(`[data-cmd="edit:${action}"]:not(.disabled)`));
      } else await wd.click(await wd.waitFor(selector, 12000));
      // The reverse control becoming available confirms that the edit committed
      // before Ctrl+S captures it (especially React-backed PDF annotations).
      if (format !== "hwpx") await wd.waitFor(format === "docx" ? (action === "undo" ? undo : redo) : action === "undo" ? redo : undo, 12000);
      await key("s");
      const wantMarker = action === "redo";
      const ok = await until(async () => await revision() > before && (await readSaved()).includes(marker) === wantMarker, 20000);
      const after = await revision();
      writeFileSync(ctx.report.path(`suite-${format}-${action}-saved.txt`), await readSaved());
      ctx.report.check(S, format === "docx" ? (action === "undo" ? "원본 AI 이전 상태로 되돌리기·실제 파일 저장" : "원본 Undo로 이전 상태 복원을 취소·실제 파일 저장") : action === "undo" ? "자동 저장 뒤 원본 되돌리기·실제 파일 저장" : "되돌린 판 저장 뒤 다시 실행·실제 파일 저장", ok, `r${before} → r${after}`, await shot(ctx, `suite-${format}-${action}.png`));
      if (!ok) throw new Error(`${format} ${action} did not persist the expected document`);
      before = after;
      if (action === "undo") await afterUndo?.();
    } catch (error) {
      writeFileSync(ctx.report.path(`suite-${format}-${action}-controls.json`), JSON.stringify(await wd.execute('return [...document.querySelectorAll("button")].filter(el=>/실행|되돌|Undo|Redo/.test((el.getAttribute("aria-label")||"")+el.textContent)).map(el=>({html:el.outerHTML,rect:el.getBoundingClientRect().toJSON()}));').catch(() => []), null, 2));
      throw error;
    }
  } } finally {
    if (format === "hwpx") { await wd.frame(null); await wd.frame(await wd.waitFor("iframe.office-frame")); }
  }
}

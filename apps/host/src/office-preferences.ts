import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeAiPanelPrefs } from "../../../vendor/ieumoffice/packages/ui/src/ai-panel-prefs.ts";
import { sanitizeAuthorName, systemAuthorName } from "../../../vendor/ieumoffice/packages/electron-utils/src/author-name.ts";
import type { OfficePreferencesSnapshot } from "../../../packages/contracts/src/office-preferences.ts";
import { HttpError } from "./errors.ts";

const fail = (message: string, status = 400) => new HttpError(status, "office_preferences", message);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const panelFields = { side: "aiPanelSide", fontSize: "aiPanelFontSize", customFontSize: "aiPanelCustomFontSize", spellcheck: "aiPanelSpellcheck", openInNewDocs: "aiPanelOpenInNewDocs", showAiSidebar: "aiPanelShowSidebar" } as const;
const panelOf = (raw: Record<string, unknown>) => normalizeAiPanelPrefs(Object.fromEntries(Object.entries(panelFields).map(([key, name]) => [key, raw[name]])));
const storedPanel = (raw: unknown) => Object.fromEntries(Object.entries(normalizeAiPanelPrefs(raw)).map(([key, value]) => [panelFields[key as keyof typeof panelFields], value]));

/** Only document display preferences cross the import boundary; no paths or executable consent. */
export function importedOfficePreferences(value: unknown): Record<string, unknown> {
  if (!object(value)) return {};
  const result: Record<string, unknown> = {};
  if (typeof value.authorName === "string") result.authorName = sanitizeAuthorName(value.authorName);
  if (["follow", "light", "dark"].includes(String(value.documentTheme))) result.documentTheme = value.documentTheme;
  if (typeof value.autoSaveDefault === "boolean") result.autoSaveDefault = value.autoSaveDefault;
  const normalized = storedPanel(panelOf(value));
  for (const name of Object.values(panelFields)) if (name in value) result[name] = normalized[name];
  return result;
}

export class OfficePreferences {
  readonly path: string;
  constructor(dataDir: string) { this.path = join(dataDir, "office", "app-settings.json"); }
  private read() {
    if (!existsSync(this.path)) return { raw: Buffer.from(""), value: {} as Record<string, unknown>, revision: digest("missing") };
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) throw fail("문서 설정 파일을 읽을 수 없습니다. 기존 파일을 보존했습니다.", 409);
    const raw = readFileSync(this.path);
    let value: unknown; try { value = JSON.parse(raw.toString("utf8")); } catch { throw fail("문서 설정 JSON을 읽을 수 없습니다. 기존 파일을 보존했습니다.", 409); }
    if (!object(value)) throw fail("문서 설정 형식이 올바르지 않습니다. 기존 파일을 보존했습니다.", 409);
    return { raw, value, revision: digest(raw) };
  }
  snapshot(): OfficePreferencesSnapshot {
    const { value, revision } = this.read();
    return { revision, author: { value: sanitizeAuthorName(value.authorName), fallback: systemAuthorName() },
      aiPanel: panelOf(value), panelConfigured: Object.values(panelFields).some(key => key in value),
      documentTheme: value.documentTheme === "dark" || value.documentTheme === "light" ? value.documentTheme : "follow",
      autoSaveDefault: { on: value.autoSaveDefault === true, updatedAt: typeof value.autoSaveDefaultUpdatedAt === "number" && Number.isFinite(value.autoSaveDefaultUpdatedAt) ? value.autoSaveDefaultUpdatedAt : 0 } };
  }
  write(patch: Record<string, unknown>, expectedRevision?: string, backup = false) {
    const current = this.read();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw fail("문서 설정이 변경되었습니다. 가져올 항목을 다시 확인해 주세요.", 409);
    const values = importedOfficePreferences(patch), next = { ...current.value, ...values };
    if ("autoSaveDefault" in values) next.autoSaveDefaultUpdatedAt = Date.now();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let backupPath: string | null = null;
    if (backup && current.raw.length) {
      const folder = join(dirname(this.path), "preference-history"); mkdirSync(folder, { recursive: true, mode: 0o700 });
      backupPath = join(folder, `${current.revision}.json`);
      if (!existsSync(backupPath)) writeFileSync(backupPath, current.raw, { flag: "wx", mode: 0o600 });
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { flag: "wx", mode: 0o600 }); renameSync(temporary, this.path); }
    finally { rmSync(temporary, { force: true }); }
    return { snapshot: this.snapshot(), backup: backupPath };
  }
  setPanel(patch: unknown, legacy?: unknown) {
    if (!object(patch)) throw fail("AI 패널 설정을 확인해 주세요.");
    const current = this.snapshot(), prev = !current.panelConfigured && legacy !== undefined ? normalizeAiPanelPrefs(legacy) : current.aiPanel;
    const next = normalizeAiPanelPrefs({ ...prev, ...patch, side: patch.side === "left" || patch.side === "right" ? patch.side : prev.side });
    return this.write(storedPanel(next)).snapshot;
  }
  invoke(channel: string, args: unknown[]) {
    switch (channel) {
      case "home:get-author-name": return this.snapshot().author;
      case "home:set-author-name": return this.write({ authorName: sanitizeAuthorName(args[0]) }).snapshot.author;
      case "home:get-ai-panel-prefs": return this.snapshot().aiPanel;
      case "home:set-ai-panel-prefs": return this.setPanel(args[0]).aiPanel;
      case "home:get-document-theme": return this.snapshot().documentTheme;
      case "home:set-document-theme": {
        if (!["follow", "light", "dark"].includes(String(args[0]))) throw fail("문서 테마를 확인해 주세요.");
        return this.write({ documentTheme: args[0] }).snapshot.documentTheme;
      }
      case "home:get-auto-save-default": return this.snapshot().autoSaveDefault;
      case "home:set-auto-save-default": {
        if (typeof args[0] !== "boolean") throw fail("자동 저장 설정을 확인해 주세요.");
        return this.write({ autoSaveDefault: args[0] }).snapshot.autoSaveDefault;
      }
      default: throw fail("지원하지 않는 문서 설정 요청입니다.");
    }
  }
}

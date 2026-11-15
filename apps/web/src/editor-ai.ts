import type { Api } from "./api.ts";

// The editors' own "AI 도우미" panel (Word, PowerPoint, Excel, PDF, Markdown, HTML): it edits the OPEN
// document live and can do what 문서 AI cannot (every PDF write, selection edits, layout fixes); 문서 AI
// works on a copy and returns a 수정안. Its "show" preference lives in the editors' settings file
// (apps/host/src/office-preferences.ts showAiSidebar); the editors read it every few seconds.

type PanelPrefs = { showAiSidebar?: boolean };
const call = (api: Api, channel: string, args: unknown[] = []) => api.request<PanelPrefs>("POST", "/api/office-preferences", { channel, args });

export const EDITOR_AI_DIFFERENCE = "열린 문서를 그 자리에서 바로 고칩니다. 문서 AI는 사본에서 고친 뒤 수정안으로 돌려줍니다. PDF에 직접 쓰는 일은 편집기 안 AI 도우미만 합니다.";

/** Whether the editors show their own AI 도우미 (and its rail key beside the page). */
export async function editorAiShown(api: Api): Promise<boolean> {
  return (await call(api, "home:get-ai-panel-prefs")).showAiSidebar !== false;
}

/** Turn the editors' own AI 도우미 on or off; returns what is stored now. */
export async function setEditorAiShown(api: Api, on: boolean): Promise<boolean> {
  return (await call(api, "home:set-ai-panel-prefs", [{ showAiSidebar: on }])).showAiSidebar !== false;
}

/** Make sure the panel can be shown (a person's "off" is turned on only when they ask for the panel). */
export async function ensureEditorAiShown(api: Api): Promise<void> {
  if (!(await editorAiShown(api))) await setEditorAiShown(api, true);
}

/** Formats whose editor has its own AI 도우미 apart from 문서 AI (Hangul's dock IS the head's 문서 AI). */
export const hasEditorAi = (format: string) => ["docx", "pptx", "xlsx", "pdf", "markdown", "html"].includes(format);

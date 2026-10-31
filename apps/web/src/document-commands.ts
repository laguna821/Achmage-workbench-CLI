/** Saves in mounted editors; another window must confirm saving in its own editor. */
import type { RendererControlRequest, RendererControlReply } from "../../../packages/contracts/src/office-control.ts";
type Editor = { artifactId: string; dirty(): boolean; save(): Promise<number | null>; flushBeforeReference?(): boolean; control?(request: RendererControlRequest): Promise<RendererControlReply> };
const editors = new Map<string, Editor>();

export function controlDocument(viewId: string, request: RendererControlRequest): Promise<RendererControlReply> {
  return editors.get(viewId)?.control?.(request) ?? Promise.resolve({ status: "not_ready" });
}

export function registerDocumentCommands(viewId: string, editor: Editor) {
  editors.set(viewId, editor);
  return () => { if (editors.get(viewId) === editor) editors.delete(viewId); };
}

export async function saveReferencedDocument(artifactId: string): Promise<number | undefined> {
  let revision: number | undefined;
  for (const editor of [...editors.values()].filter((entry) => entry.artifactId === artifactId)) {
    // Original Office engines report dirty state asynchronously. Ask their
    // live writer even if the last status poll still said clean.
    if (!editor.dirty() && !editor.flushBeforeReference?.()) continue;
    const saved = await editor.save();
    if (saved === null) throw new Error("참조 문서를 저장하지 못해 보내지 않았습니다. 해당 편집기에서 확인하거나 ‘저장된 판만’을 선택해 주세요.");
    revision = saved;
  }
  return revision;
}

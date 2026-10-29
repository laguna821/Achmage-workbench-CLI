/** Saves in mounted editors; another window must confirm saving in its own editor. */
type Editor = { artifactId: string; dirty(): boolean; save(): Promise<number | null> };
const editors = new Map<string, Editor>();

export function registerDocumentCommands(viewId: string, editor: Editor) {
  editors.set(viewId, editor);
  return () => { if (editors.get(viewId) === editor) editors.delete(viewId); };
}

export async function saveReferencedDocument(artifactId: string): Promise<number | undefined> {
  let revision: number | undefined;
  for (const editor of [...editors.values()].filter((entry) => entry.artifactId === artifactId)) {
    if (!editor.dirty()) continue;
    const saved = await editor.save();
    if (saved === null) throw new Error("참조 문서를 저장하지 못해 보내지 않았습니다. 해당 편집기에서 확인하거나 ‘저장된 판만’을 선택해 주세요.");
    revision = saved;
  }
  return revision;
}

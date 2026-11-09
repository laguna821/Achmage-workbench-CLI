import { patchDocumentExecutions } from "./execution-patch-documents.ts";
import { patchExecutionTransport } from "./execution-transport-patch.ts";
import { patchPresentationExecutions } from "./execution-patch-presentations.ts";
import { patchBookExecutions } from "./execution-patch-books.ts";
import { patchPdfJobExecutions } from "./execution-patch-pdf-jobs.ts";

/** Pinned adapters call the original panel's send path, retaining its preparation,
 * document writer and tool set. A changed upstream boundary fails explicitly. */
export function patchOfficeExecution(code: string, id: string, root: string, module: string) {
  code = patchExecutionTransport(code, id, root, module);
  code = patchDocumentExecutions(code, id, root, module);
  code = patchPresentationExecutions(code, id, root, module);
  code = patchBookExecutions(code, id, root, module);
  code = patchPdfJobExecutions(code, id, root, module);
  if (id !== `${root}/apps/markdown/src/renderer/ai/AiPanel.tsx`) return code;
  const marker = "  const stop = (): void => {";
  const gate = "    if (!sendGate.admit({ text: instruction, displayText, retryScope, skillUse })) {";
  const question = "    const keep = await new Promise<boolean>((resolve) => {";
  const cleanup = "      loopRef.current?.cancel()\n      const editor = depsRef.current.getEditor()";
  for (const boundary of [marker, gate, question, cleanup]) if (code.split(boundary).length !== 2) throw new Error("Original Markdown executor boundary changed");
  code = code.replace(gate, "    if (!isOfficeExecutor() && !sendGate.admit({ text: instruction, displayText, retryScope, skillUse })) {")
    .replace(question, "    const keep = isOfficeExecutor() ? await askOfficeExecutionQuestion('작성 중인 문서가 길이 제한에 도달했습니다. 지금까지 작성한 내용을 유지할까요?') : await new Promise<boolean>((resolve) => {")
    .replace(cleanup, "      loopRef.current?.detach()\n      const editor = depsRef.current.getEditor()");
  code = code.replace(marker, `  useEffect(() => registerOriginalExecutor({
    ready: () => Boolean(depsRef.current.getEditor()),
    capture: () => {
      const editor = depsRef.current.getEditor();
      if (!editor) throw new Error('문서를 먼저 열어 주세요.');
      return { format: 'markdown', snapshot: depsRef.current.getSnapshot(), document: editor.getJSON(), selection: editor.state.selection.toJSON(), scope: lastScopeRef.current ?? null };
    },
    execute: (instruction, state) => {
      const editor = depsRef.current.getEditor();
      if (!editor || state.format !== 'markdown') return false;
      depsRef.current.restoreSnapshot(state.snapshot);
      editor.commands.setContent(state.document, { emitUpdate: false });
      const selection = editor.state.selection.constructor.fromJSON(editor.state.doc, state.selection);
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      return send(instruction, undefined, state.scope);
    },
    lock: (locked) => {
      depsRef.current.getEditor()?.setEditable(!locked);
      for (const element of document.querySelectorAll('.app-content, .ribbon')) element.inert = locked;
    },
  }), []);

${marker}`);
  return `import { registerOriginalExecutor, isOfficeExecutor, askOfficeExecutionQuestion } from ${JSON.stringify(module)};\n${code}`;
}

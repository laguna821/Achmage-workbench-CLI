/** Keep the original document engines, send preparation and tool factories.
 * State here supplements the admitted saved file; it is not a document editor.
 * An upstream boundary change must fail before a partial adapter is advertised. */
function replaceOnce(code: string, before: string, after: string, format: string): string {
  if (code.split(before).length !== 2) throw new Error(`Original ${format} executor boundary changed: ${before.split("\n")[0]?.trim()}`);
  return code.replace(before, after);
}

// Module scope keeps the original inert values across a conversation-panel remount.
// Unlocking must not enable a control which was already disabled before admission.
const lockDocument = `
const workbenchExecutionLocks = new Map<HTMLElement, boolean>();
function workbenchLockDocument(selector: string, locked: boolean) {
  if (!locked) {
    for (const [element, previous] of workbenchExecutionLocks) element.inert = previous;
    workbenchExecutionLocks.clear();
    return;
  }
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    if (!workbenchExecutionLocks.has(element)) workbenchExecutionLocks.set(element, element.inert);
    element.inert = true;
  }
}
`;

function docs(code: string, module: string): string {
  code = replaceOnce(code,
    "      !sendGate.admit({\n        instruction,\n        displayInstruction,",
    "      !isOfficeExecutor() && !sendGate.admit({\n        instruction,\n        displayInstruction,", "DOCX");
  code = replaceOnce(code,
    "    const keep = await new Promise<boolean>((resolve) => {",
    "    const keep = isOfficeExecutor() ? await askOfficeExecutionQuestion('문서 작성을 끝내지 못했습니다. 지금까지 작성한 내용을 유지할까요?') : await new Promise<boolean>((resolve) => {", "DOCX");
  const marker = "  const cancel = () => {";
  code = replaceOnce(code, marker, `  const workbenchSendRef = useRef(runWith);
  workbenchSendRef.current = runWith;
  useEffect(() => {
    const unregister = registerOriginalExecutor({
      ready: () => Boolean(editorRef.current && !editorRef.current.isDestroyed),
      capture: () => {
        const editor = editorRef.current;
        if (!editor || editor.isDestroyed) throw new Error('문서를 먼저 열어 주세요.');
        const { doc, selection } = editor.state;
        return { format: 'docx', data: JSON.parse(JSON.stringify({
          selection: selection.toJSON(),
          selectedText: doc.textBetween(selection.from, selection.to, '\\n'),
          beforeSelection: doc.textBetween(Math.max(0, selection.from - 64), selection.from, '\\n'),
          afterSelection: doc.textBetween(selection.to, Math.min(doc.content.size, selection.to + 64), '\\n'),
          scope: lastScopeRef.current ?? null,
          trackChanges: trackChangesRef.current,
          attachments: lastAttachmentsRef.current,
          availableAttachments: availableAttachments(),
        })) };
      },
      execute: async (instruction, state) => {
        if (state.format !== 'docx' || loopRef.current?.busy || pendingSendRef.current) return false;
        const generation = currentDocGeneration();
        // DOCX opens large documents progressively. Restore the original selection
        // only after the complete saved document has reached its original editor.
        await waitForFullContent();
        const editor = editorRef.current;
        if (!editor || editor.isDestroyed || currentDocGeneration() !== generation) throw new Error('실행할 문서가 바뀌었습니다.');
        const data = state.data as {
          selection: Record<string, unknown>; selectedText: string; beforeSelection: string; afterSelection: string;
          scope: AiScopeQuoteData | null; trackChanges: boolean;
          attachments: AttachmentMeta[]; availableAttachments: AttachmentMeta[];
        };
        const selection = WorkbenchDocumentSelection.fromJSON(editor.state.doc, data.selection);
        const doc = editor.state.doc;
        if (doc.textBetween(selection.from, selection.to, '\\n') !== data.selectedText
          || doc.textBetween(Math.max(0, selection.from - 64), selection.from, '\\n') !== data.beforeSelection
          || doc.textBetween(selection.to, Math.min(doc.content.size, selection.to + 64), '\\n') !== data.afterSelection) {
          throw new Error('저장된 문서에서 선택 범위를 확인하지 못했습니다. 문서를 다시 열고 선택해 주세요.');
        }
        editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta('addToHistory', false));
        trackChangesRef.current = data.trackChanges;
        setTrackChanges(data.trackChanges);
        sentAttachmentsRef.current = data.availableAttachments;
        workbenchSendRef.current(instruction, instruction, data.attachments, data.scope);
        return Boolean(pendingSendRef.current || loopRef.current?.busy);
      },
      lock: (locked) => {
        const editor = editorRef.current;
        if (locked && editor && !editor.isDestroyed) {
          if (!workbenchEditable.has(editor)) workbenchEditable.set(editor, editor.isEditable);
          editor.setEditable(false);
        } else if (!locked) {
          for (const [original, editable] of workbenchEditable) if (!original.isDestroyed) original.setEditable(editable);
          workbenchEditable.clear();
        }
        workbenchLockDocument('.app-content, .ribbon', locked);
      },
    });
    return () => { unregister(); loopRef.current?.detach(); };
  }, []);

${marker}`, "DOCX");
  return `import { registerOriginalExecutor, isOfficeExecutor, askOfficeExecutionQuestion } from ${JSON.stringify(module)};
import { Selection as WorkbenchDocumentSelection } from '@tiptap/pm/state';
${lockDocument}
const workbenchEditable = new Map<Editor, boolean>();
${code}`;
}

function hwp(code: string, module: string): string {
  code = replaceOnce(code,
    "      !sendGate.admit({\n        text: instruction,\n        attachments: attachmentsOverride,\n        scope: sentScope,",
    "      !isOfficeExecutor() && !sendGate.admit({\n        text: instruction,\n        attachments: attachmentsOverride,\n        scope: sentScope,", "HWP");
  code = replaceOnce(code,
    "      confirmMemoRemoval: (refusal) => memoGateRef.current!.ask(refusal),",
    `      confirmMemoRemoval: (refusal) => isOfficeExecutor()
        ? askOfficeExecutionQuestion([
            t('aiMemoApprovalTitle', { count: refusal.count }),
            ...refusal.memos.map((memo) => [
              memo.author.trim() || t('memoUnknownAuthor'),
              memo.page > 0 ? t('memoPage', { page: memo.page }) : '',
              memoApprovalPreview(memo),
            ].filter(Boolean).join(' · ')),
            '이 편집으로 위 메모를 삭제할까요?',
          ].join('\\n'))
        : memoGateRef.current!.ask(refusal),`, "HWP");
  code = replaceOnce(code,
    "      memoGateRef.current?.cancel()\n      loopRef.current?.cancel()",
    "      memoGateRef.current?.cancel()\n      loopRef.current?.detach()", "HWP");
  const marker = "  const stop = (): void => {";
  code = replaceOnce(code, marker, `  const workbenchSendRef = useRef(send);
  workbenchSendRef.current = send;
  useEffect(() => registerOriginalExecutor({
    ready: () => Boolean(skillRef.current && document.querySelector('.hwp-app[data-phase="ready"]')),
    capture: () => ({ format: 'hwpx', data: JSON.parse(JSON.stringify({
      scope: runScopeRef.current,
      attachments: runAttachmentsRef.current,
      availableAttachments: availableAttachmentsRef.current(),
    })) }),
    execute: async (instruction, state) => {
      if ((state.format !== 'hwpx' && state.format !== 'hwp') || loopRef.current?.busy) return false;
      if (!document.querySelector('.hwp-app[data-phase="ready"]')) return false;
      // The plugin loads asynchronously inside the original rhwp frame. This read
      // establishes readiness without changing the document or inventing a bridge.
      await bridgeRef.current.readText();
      const data = state.data as {
        scope: SelectionScope | null; attachments: AttachmentMeta[]; availableAttachments: AttachmentMeta[];
      };
      sentAttachmentsRef.current = data.availableAttachments;
      // send() restores the original multi-paragraph/table selection into the HWP
      // skill, refreshes its context and keeps the original stale-range checks.
      return workbenchSendRef.current(instruction, data.attachments, data.scope);
    },
    lock: (locked) => workbenchLockDocument('.hwp-stage, .hwp-topbar, .memo-panel', locked),
  }), []);

${marker}`, "HWP");
  return `import { registerOriginalExecutor, isOfficeExecutor, askOfficeExecutionQuestion } from ${JSON.stringify(module)};\n${lockDocument}\n${code}`;
}

function mindmap(code: string, module: string): string {
  code = replaceOnce(code,
    "    if (!sendGate.admit({ text: instruction, attachments: attachmentsOverride, skillUse })) {",
    "    if (!isOfficeExecutor() && !sendGate.admit({ text: instruction, attachments: attachmentsOverride, skillUse })) {", "XMind");
  code = replaceOnce(code,
    "      mountedRef.current = false\n      loopRef.current?.cancel()",
    "      mountedRef.current = false\n      loopRef.current?.detach()", "XMind");
  code = replaceOnce(code,
    "  const attachmentsRef = useRef(attachments)",
    "  const workbenchRunAttachmentsRef = useRef<AttachmentMeta[]>([]);\n  const attachmentsRef = useRef(attachments)", "XMind");
  code = replaceOnce(code,
    "    const sentAtts = attachmentsOverride ?? attachmentsRef.current",
    "    const sentAtts = attachmentsOverride ?? attachmentsRef.current\n    workbenchRunAttachmentsRef.current = sentAtts", "XMind");
  const marker = "  const cancelPendingSend = (): void => {";
  code = replaceOnce(code, marker, `  useEffect(() => registerOriginalExecutor({
    ready: () => {
      const host = hostRef.current;
      const key = host.activeSheetKey();
      return Boolean(host.session() && key && host.controllerOf(key));
    },
    capture: () => {
      const host = hostRef.current;
      host.flush();
      const session = host.session(), key = host.activeSheetKey();
      if (!session || !key) throw new Error('마인드맵을 먼저 열어 주세요.');
      const sheet = session.sheet(key);
      return { format: 'xmind', data: JSON.parse(JSON.stringify({
        sheetId: typeof sheet.id === 'string' ? sheet.id : null,
        sheetIndex: session.indexOf(key),
        rootId: session.view(key).root.id,
        selectedTopicIds: host.controllerOf(key)?.selectedTopicIds() ?? [],
        attachments: workbenchRunAttachmentsRef.current,
        availableAttachments: availableAttachments(),
      })) };
    },
    execute: async (instruction, state) => {
      if (state.format !== 'xmind' || loopRef.current?.busy) return false;
      const session = hostRef.current.session();
      if (!session) return false;
      const data = state.data as {
        sheetId: string | null; sheetIndex: number; rootId: string; selectedTopicIds: string[];
        attachments: AttachmentMeta[]; availableAttachments: AttachmentMeta[];
      };
      // Session tab keys are process-local. Resolve the saved sheet identity before
      // asking the original application to mount its real MapController.
      const tabs = session.tabs();
      const tab = data.sheetId === null ? tabs[data.sheetIndex]
        : tabs.find((candidate) => session.sheet(candidate.key).id === data.sheetId);
      if (!tab || session.view(tab.key).root.id !== data.rootId) throw new Error('실행할 마인드맵 시트가 바뀌었습니다.');
      hostRef.current.showSheet(tab.key);
      const controller = await workbenchControllerFor(hostRef.current, tab.key);
      const until = Date.now() + 3000;
      while (hostRef.current.activeSheetKey() !== tab.key && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      if (!controller || hostRef.current.session() !== session || hostRef.current.activeSheetKey() !== tab.key) {
        throw new Error('마인드맵 시트가 편집 준비를 마치지 못했습니다.');
      }
      const topics = data.selectedTopicIds.map((id) => {
        const topic = controller.mind.findEle(id);
        if (!topic || topic.nodeObj.id !== id) throw new Error('선택한 마인드맵 항목이 바뀌었습니다.');
        return topic;
      });
      controller.mind.unselectNodes(controller.mind.currentNodes ?? []);
      if (topics.length) controller.mind.selectNodes(topics);
      sentAttachmentsRef.current = data.availableAttachments;
      return sendRef.current(instruction, data.attachments);
    },
    lock: (locked) => workbenchLockDocument('.ribbon, .mm-card, .mm-foot, .mm-stage > :not(.ai-dock)', locked),
  }), []);

${marker}`, "XMind");
  return `import { registerOriginalExecutor, isOfficeExecutor } from ${JSON.stringify(module)};
import { controllerFor as workbenchControllerFor } from './map-tools';
${lockDocument}
${code}`;
}

export function patchDocumentExecutions(code: string, id: string, root: string, module: string): string {
  if (id === `${root}/apps/docs/src/renderer/ai/AiPanel.tsx`) return docs(code, module);
  if (id === `${root}/apps/hwp/src/renderer/ai/AiPanel.tsx`) return hwp(code, module);
  if (id === `${root}/apps/mindmap/src/renderer/ai/AiPanel.tsx`) return mindmap(code, module);
  return code;
}
